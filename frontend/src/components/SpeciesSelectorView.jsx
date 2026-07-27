import React, { useState, useEffect, useLayoutEffect, useMemo, useCallback, useRef } from 'react'
import { IconTrash } from './ConfigurationView'
import FileBrowserModal from './FileBrowserModal'
import AppButtonIcon from './AppButtonIcon'
import ScreenshotExportModal from './ScreenshotExportModal'
import ScreenshotSelectionOverlay from './ScreenshotSelectionOverlay'
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

const FASTA_EXTENSIONS = ['.fa', '.fna', '.fasta', '.fa.gz', '.fna.gz', '.fasta.gz', '.fa.bgz', '.fna.bgz', '.fasta.bgz']
const GFF3_EXTENSIONS = ['.gff3', '.gff3.gz', '.gff3.bgz']
const HOMOLOGY_EXTENSIONS = ['.tsv', '.tsv.gz']
const LOCAL_PAGE_SIZE = 10
const PLAYLIST_ALL_ID = '__all__'
const SELECTOR_PENDING_GENOMES_STORAGE_KEY = 'ensembl_selector_pending_genomes'
const SELECTOR_REFRESH_EVENT = 'ensembl:selector-refresh'
const GENOME_FILE_EDITOR_TYPES = ['fasta', 'gff3', 'homology', 'cdna', 'protein', 'xref', 'gff3_index', 'gtf_index', 'cdna_index', 'protein_index']

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

const localFileTypeLabel = (type) => (type === 'protein_index' ? 'PROT_INDEX' : String(type || '').toUpperCase())

const IconChevron = ({ open, size = 14 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.15s ease' }} aria-hidden="true">
        <polyline points="6 9 12 15 18 9" />
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

function GenomeFileEditor({ item, effectiveFiles, isLight, confirmDeleteFile, setConfirmDeleteFile, onDeleteFile, onBrowse, onSavePath }) {
    const genomeKey = itemKey(item)

    const [editPaths, setEditPaths] = React.useState(() => ({ ...effectiveFiles }))
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

    const handleBlur = (type, value) => {
        const prev = effectiveFiles[type] || ''
        if (value !== prev) onSavePath(type, value)
        // Restore end-visible scroll after blur
    }

    return (
        <div className={`rounded-lg border overflow-hidden ${isLight ? 'bg-white border-gray-200' : 'bg-gray-800/60 border-gray-700'}`}>
            <div className={`grid items-center gap-2 px-3 py-2 border-b text-[10px] font-bold uppercase tracking-widest ${isLight ? 'bg-gray-50 border-gray-200 text-gray-500' : 'bg-gray-750 border-gray-700 text-gray-400'}`} style={{ gridTemplateColumns: '132px 150px minmax(180px,1fr) 78px' }}>
                <span>Type</span>
                <span>File</span>
                <span>Path</span>
                <span className="text-right">Actions</span>
            </div>
            <div className={`divide-y ${isLight ? 'divide-gray-100' : 'divide-gray-700/60'}`}>
                {GENOME_FILE_EDITOR_TYPES.map((type) => {
                    const path = effectiveFiles[type] || ''
                    const editPath = editPaths[type] ?? path
                    const isConfirmingDelete = confirmDeleteFile?.fileType === type && confirmDeleteFile?.path === path && itemKey(confirmDeleteFile?.item) === genomeKey
                    const typeLabel = localFileTypeLabel(type)
                    const filename = basenameFromPath(editPath || path)

                    return (
                        <div
                            key={type}
                            className={`grid items-center gap-2 px-3 py-1.5 text-xs ${rowHover}`}
                            style={{ gridTemplateColumns: '132px 150px minmax(180px,1fr) 78px' }}
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
                    )
                })}
            </div>
        </div>
    )
}

const hasAnySuffix = (value, suffixes) => {
    const lower = (value || '').toLowerCase()
    return suffixes.some((suffix) => lower.endsWith(suffix))
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

const joinPath = (base, child) => {
    if (!base) return child
    if (!child) return base
    if (base === '/') return `/${child}`
    return `${base.replace(/\/+$/, '')}/${child}`
}

const stripGffSuffix = (filename = '') => filename.replace(/\.gff3(\.gz)?$/i, '')

const deriveIndexPathFromGff = (gffPath = '', fallbackDir = '') => {
    if (!gffPath) return ''
    const file = basenameFromPath(gffPath)
    const prefix = stripGffSuffix(file) || 'genome'
    const dir = dirnameFromPath(gffPath) || fallbackDir || '.'
    return joinPath(dir, `${prefix}.gff3.index.db`)
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

const detectGenomeFiles = (items) => {
    const matches = { fasta: [], gff3: [], homology: [] }
    for (const item of items || []) {
        if (!item || item.is_dir) continue
        if (hasAnySuffix(item.name, FASTA_EXTENSIONS)) {
            matches.fasta.push(item.path)
        } else if (hasAnySuffix(item.name, GFF3_EXTENSIONS)) {
            matches.gff3.push(item.path)
        } else if (hasAnySuffix(item.name, HOMOLOGY_EXTENSIONS)) {
            matches.homology.push(item.path)
        }
    }

    const warnings = []
    const autodetected = { fasta: '', gff3: '', homology: '' }

    for (const field of Object.keys(matches)) {
        if (matches[field].length === 1) {
            autodetected[field] = matches[field][0]
        } else if (matches[field].length > 1) {
            warnings.push(`Multiple ${field.toUpperCase()} files found. Choose ${field.toUpperCase()} manually.`)
        }
    }

    return { autodetected, warnings }
}

const deriveSpeciesMeta = ({ directory, gff3, fasta }) => {
    const candidatePath = gff3 || fasta || directory || ''
    const normalizedPath = String(candidatePath || '').replace(/\\/g, '/')
    const pathParts = normalizedPath.split('/').filter(Boolean)
    const localDataIdx = pathParts.lastIndexOf('local_data')

    let speciesKey = ''
    let assembly = ''

    if (localDataIdx >= 0 && pathParts.length > localDataIdx + 2) {
        speciesKey = pathParts[localDataIdx + 1]
        assembly = pathParts[localDataIdx + 2]
    }

    const gffPrefix = stripGffSuffix(basenameFromPath(gff3 || ''))
    const dirBase = basenameFromPath(directory || dirnameFromPath(candidatePath))

    if (!assembly) {
        assembly = gffPrefix || dirBase || 'manual_assembly'
    }
    if (!speciesKey) {
        speciesKey = toSpeciesKey(formatSpeciesNameFromKey(dirBase) || assembly || 'manual_species') || 'manual_species'
    }

    const gca = /^GC[AF]_/i.test(assembly || '') ? assembly : ''

    return {
        species_key: speciesKey,
        assembly,
        assembly_name: assembly,
        scientific_name: formatSpeciesNameFromKey(speciesKey) || 'Manual Species',
        common_name: '',
        gca,
    }
}

function ManualPathRow({ label, value, onBrowse, placeholder, isLight }) {
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
    onLabelChange,
    onPathChange,
    onBrowse,
    onCancel,
    onImport,
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
    const canImport = Boolean(String(path || '').trim()) && Boolean(String(label || '').trim()) && !importing

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
                            GFF3 file
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
                        </div>
                    </div>
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

export default function SpeciesSelectorView({
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

    const [assemblies, setAssemblies] = useState([])
    const [loading, setLoading] = useState(false)
    const [search, setSearch] = useState('')
    const [page, setPage] = useState(1)
    const [confirmDelete, setConfirmDelete] = useState(null)
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
    const [playlistMembershipTarget, setPlaylistMembershipTarget] = useState(null)
    const [editingPlaylistId, setEditingPlaylistId] = useState('')
    const [playlistsCollapsed, setPlaylistsCollapsed] = useState(true)
    const [selectorPlaylistId, setSelectorPlaylistId] = useState(PLAYLIST_ALL_ID)
    const [downloadingMissingKeys, setDownloadingMissingKeys] = useState(new Set())

    const [manualOpen, setManualOpen] = useState(false)
    const [manualDirectory, setManualDirectory] = useState(config.output_dir || '.')
    const [manualSpeciesLabel, setManualSpeciesLabel] = useState('')
    const [manualAssemblyLabel, setManualAssemblyLabel] = useState('')
    const [manualGca, setManualGca] = useState('')
    const [manualFasta, setManualFasta] = useState('')
    const [manualGff3, setManualGff3] = useState('')
    const [manualHomology, setManualHomology] = useState('')
    const [manualIndexPath, setManualIndexPath] = useState('')
    const [manualWarnings, setManualWarnings] = useState([])
    const [detectingDirectory, setDetectingDirectory] = useState(false)
    const [customAnnotationTarget, setCustomAnnotationTarget] = useState(null)
    const [customAnnotationLabel, setCustomAnnotationLabel] = useState(defaultCustomAnnotationLabel())
    const [customAnnotationPath, setCustomAnnotationPath] = useState('')
    const [importingCustomAnnotation, setImportingCustomAnnotation] = useState(false)

    const [modalOpen, setModalOpen] = useState(false)
    const [modalMode, setModalMode] = useState('file')
    const [modalTarget, setModalTarget] = useState('')

    const showStatus = (msg, isError = false) => {
        setStatusMessage({ text: msg, isError })
        setTimeout(() => setStatusMessage(null), 3500)
    }

    const fetchAssemblies = useCallback(async () => {
        if (!config.output_dir) {
            setAssemblies([])
            return
        }
        setLoading(true)
        try {
            const res = await fetch(`${API_BASE}/api/remote/local-assemblies?output_dir=${encodeURIComponent(config.output_dir)}`)
	            if (res.ok) {
                const data = await res.json()
                const pendingIds = readPendingSelectorGenomeIds()
                const assemblies = (Array.isArray(data) ? data : []).map((item) => {
                    const normalized = normalizeGenomeRecord(item)
                    const datasetInstances = (Array.isArray(item?.dataset_instances) ? item.dataset_instances : [])
                        .map((instance) => normalizeGenomeRecord(instance))
                    return { ...normalized, dataset_instances: datasetInstances }
                })
                setAssemblies(assemblies.filter((item) => !pendingIds.has(itemKey(item)) && !pendingIds.has(item.assembly_key)))
	            }
	            else {
	                console.warn('Failed to refresh local assemblies:', res.statusText)
	            }
	        } catch (error) {
	            console.warn('Failed to refresh local assemblies:', error)
	        } finally {
	            setLoading(false)
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
                : (item?.is_manual ? (dirnameFromPath(gff3Path) || manualDirectory || config.output_dir) : config.output_dir)

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
                await fetchAssemblies()
                if (onComplete) onComplete(indexPath)
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
    }, [config.output_dir, fetchAssemblies, manualDirectory])

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
            return { ...prev, genome_file_overrides: nextOverrides }
        })
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
    }, [config.genome_file_overrides, onConfigChange, persistBuiltIndex, ensureIndexForGenome])

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
        for (const item of assemblies || []) byKey.set(itemKey(item), normalizeGenomeRecord(item))
        for (const item of manualAssemblies) {
            const key = itemKey(item)
            if (!byKey.has(key)) byKey.set(key, item)
        }
        return Array.from(byKey.values())
    }, [assemblies, manualAssemblies])
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


    useEffect(() => {
        const active = config.active_species || []
        const candidates = []

        if (config.ref_gff) {
            const refItem = active.find((s) => s.files?.gff3 === config.ref_gff)
            if (refItem) candidates.push(refItem)
        }
        if (config.target_gff) {
            const tgtItem = active.find((s) => s.files?.gff3 === config.target_gff)
            if (tgtItem && !candidates.some((c) => itemKey(c) === itemKey(tgtItem))) {
                candidates.push(tgtItem)
            }
        }

        candidates.forEach((item) => {
            ensureIndexForGenome(item)
        })
    }, [config.active_species, config.ref_gff, config.target_gff, ensureIndexForGenome])

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

    const removeManualGenome = (item) => {
        const key = itemKey(item)
        const nextManual = (config.manual_species || []).filter((s) => itemKey(s) !== key)
        const nextActive = (config.active_species || []).filter((s) => itemKey(s) !== key)

        const updates = {
            manual_species: nextManual,
            active_species: nextActive,
        }

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
        showStatus(`Removed manual genome: ${item.scientific_name} (${item.assembly})`)
    }

    const handleDelete = async (item) => {
        if (item?.is_manual) {
            removeManualGenome(item)
            setConfirmDelete(null)
            return
        }

        try {
            const res = await fetch(`${API_BASE}/api/remote/local-files`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    output_dir: config.output_dir,
                    species_key: item.species_key,
                    assembly: item.assembly,
                    provider: normalizeGenomeProvider(item),
                }),
            })
            if (res.ok) {
                showStatus(`Deleted ${item.scientific_name} (${item.assembly})`)

                const key = itemKey(item)
                const activeSpecies = config.active_species || []
                if (activeSpecies.some((s) => itemKey(s) === key)) {
                    onConfigChange({
                        ...config,
                        active_species: activeSpecies.filter((s) => itemKey(s) !== key),
                    })
                }

                fetchAssemblies()
            } else {
                showStatus('Failed to delete files', true)
            }
        } catch (e) {
            showStatus(`Error: ${e.message}`, true)
        }
        setConfirmDelete(null)
    }

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
    }, [importingCustomAnnotation])

    const importCustomAnnotation = useCallback(async () => {
        const target = customAnnotationTarget
        const gff3Path = String(customAnnotationPath || '').trim()
        const label = String(customAnnotationLabel || '').trim() || defaultCustomAnnotationLabel()
        if (!target || !gff3Path) {
            showStatus('Choose a GFF3 file to import.', true)
            return
        }
        if (!config.output_dir) {
            showStatus('Set an Output Directory in Configuration first.', true)
            return
        }

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
            showStatus(`Imported annotation dataset: ${data?.dataset_release_label || label}`)
        } catch (error) {
            showStatus(error?.message || 'Failed to import custom annotation', true)
        } finally {
            setImportingCustomAnnotation(false)
        }
    }, [config.output_dir, customAnnotationLabel, customAnnotationPath, customAnnotationTarget, fetchAssemblies])

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

            if (item.files?.gff3) {
                await ensureIndexForGenome(item)
            }
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

    const openManualBrowser = (target, mode = 'file') => {
        setModalTarget(target)
        setModalMode(mode)
        setModalOpen(true)
    }

    const modalInitialPath = useMemo(() => {
        if (modalTarget === 'manual_directory') {
            return manualDirectory || config.output_dir || '.'
        }
        if (modalTarget === 'manual_fasta') {
            return dirnameFromPath(manualFasta || manualDirectory || config.output_dir || '.')
        }
        if (modalTarget === 'manual_gff3') {
            return dirnameFromPath(manualGff3 || manualDirectory || config.output_dir || '.')
        }
        if (modalTarget === 'manual_homology') {
            return dirnameFromPath(manualHomology || manualDirectory || config.output_dir || '.')
        }
        if (modalTarget === 'custom_annotation_gff3') {
            const targetFiles = customAnnotationTarget ? getEffectiveFiles(customAnnotationTarget) : {}
            return dirnameFromPath(customAnnotationPath || targetFiles?.gff3 || config.output_dir || '.')
        }
        if (modalTarget?.startsWith('genome_edit:') && fileBrowserEditTarget) {
            const { fileType, item } = fileBrowserEditTarget
            const effectiveFiles = getEffectiveFiles(item)
            const currentPath = effectiveFiles?.[fileType]
            return currentPath ? dirnameFromPath(currentPath) : (config.output_dir || '.')
        }
        return config.output_dir || '.'
    }, [modalTarget, manualDirectory, manualFasta, manualGff3, manualHomology, customAnnotationPath, customAnnotationTarget, config.output_dir, fileBrowserEditTarget, getEffectiveFiles])

    const modalExtensions = useMemo(() => {
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

    const autodetectDirectory = useCallback(async (directoryPath) => {
        if (!directoryPath) return
        setDetectingDirectory(true)
        try {
            const res = await fetch(`${API_BASE}/api/files/list?path=${encodeURIComponent(directoryPath)}`)
            if (!res.ok) {
                const err = await res.json()
                throw new Error(err.detail || 'Failed to list directory')
            }

            const data = await res.json()
            const resolvedDir = data.current_path || directoryPath
            const { autodetected, warnings } = detectGenomeFiles(data.items || [])
            const derivedMeta = deriveSpeciesMeta({
                directory: resolvedDir,
                gff3: autodetected.gff3 || '',
                fasta: autodetected.fasta || '',
            })

            setManualDirectory(resolvedDir)
            setManualSpeciesLabel(derivedMeta.scientific_name || '')
            setManualAssemblyLabel(derivedMeta.assembly_name || derivedMeta.assembly || '')
            setManualGca(derivedMeta.gca || '')
            setManualWarnings(warnings)
            setManualFasta(autodetected.fasta || '')
            setManualGff3(autodetected.gff3 || '')
            setManualHomology(autodetected.homology || '')
            if (autodetected.gff3) {
                setManualIndexPath(deriveIndexPathFromGff(autodetected.gff3, resolvedDir))
            } else {
                setManualIndexPath('')
            }

            if (warnings.length > 0) showStatus('Directory loaded with warnings. Review unresolved file paths.', true)
            else showStatus('Directory loaded and genome files detected.')
        } catch (e) {
            setManualWarnings([e.message || 'Failed to scan directory'])
            showStatus(`Directory scan failed: ${e.message}`, true)
        } finally {
            setDetectingDirectory(false)
        }
    }, [])

    const handleModalSelect = (path) => {
        if (modalTarget === 'manual_directory') {
            autodetectDirectory(path)
        } else if (modalTarget === 'manual_fasta') {
            setManualFasta(path)
            setManualDirectory(dirnameFromPath(path))
            setManualWarnings((prev) => prev.filter((msg) => !msg.includes('FASTA')))
        } else if (modalTarget === 'manual_gff3') {
            const nextDir = dirnameFromPath(path)
            setManualGff3(path)
            setManualDirectory(nextDir)
            setManualIndexPath(deriveIndexPathFromGff(path, nextDir))
            setManualWarnings((prev) => prev.filter((msg) => !msg.includes('GFF3')))
        } else if (modalTarget === 'manual_homology') {
            setManualHomology(path)
            setManualDirectory(dirnameFromPath(path))
            setManualWarnings((prev) => prev.filter((msg) => !msg.includes('TSV')))
        } else if (modalTarget === 'custom_annotation_gff3') {
            setCustomAnnotationPath(path)
        } else if (modalTarget?.startsWith('genome_edit:') && fileBrowserEditTarget) {
            const { fileType, item } = fileBrowserEditTarget
            saveFileOverride(item, fileType, path)
            setFileBrowserEditTarget(null)
        }
        setModalOpen(false)
    }

    const addManualGenome = () => {
        const speciesLabel = (manualSpeciesLabel || '').trim()
        const assemblyLabel = (manualAssemblyLabel || '').trim()
        const gcaLabel = (manualGca || '').trim()

        if (!speciesLabel || !assemblyLabel) {
            showStatus('Species and assembly labels are required.', true)
            return
        }

        if (!manualFasta || !manualGff3) {
            showStatus('Manual genome requires both FASTA and GFF3 paths.', true)
            return
        }

        const speciesKey = toSpeciesKey(speciesLabel) || 'manual_species'
        const assemblyCode = gcaLabel || assemblyLabel

        const manualItem = {
            species_key: speciesKey,
            assembly: assemblyCode,
            assembly_name: assemblyLabel,
            scientific_name: speciesLabel,
            common_name: '',
            provider: 'manual',
            source_database: 'Manual',
            gca: gcaLabel,
            is_manual: true,
            types: ['fasta', 'gff3', ...(manualHomology ? ['homology'] : [])],
            files: {
                fasta: manualFasta,
                gff3: manualGff3,
                homology: manualHomology || '',
                index: '',
            },
        }
        const normalizedManualItem = normalizeGenomeRecord(manualItem)

        const key = itemKey(normalizedManualItem)

        const nextManual = [...(config.manual_species || [])]
        const manualIndex = nextManual.findIndex((entry) => itemKey(entry) === key)
        if (manualIndex >= 0) nextManual[manualIndex] = normalizedManualItem
        else nextManual.push(normalizedManualItem)

        const nextActive = [...(config.active_species || [])]
        const activeIndex = nextActive.findIndex((entry) => itemKey(entry) === key)
        if (activeIndex >= 0) nextActive[activeIndex] = normalizedManualItem
        else nextActive.push(normalizedManualItem)

        const updates = {
            manual_species: nextManual,
            active_species: nextActive,
        }

        if ((config.active_species || []).length === 0 && !config.ref_gff && normalizedManualItem.files?.gff3) {
            updates.ref_fasta = normalizedManualItem.files.fasta || ''
            updates.ref_gff = normalizedManualItem.files.gff3 || ''
            updates.ref_index = normalizedManualItem.files.index || ''
            updates.homologies_file = normalizedManualItem.files.homology || ''
        }

        onConfigChange({ ...config, ...updates })
        showStatus(`Manual genome added: ${normalizedManualItem.scientific_name} (${normalizedManualItem.assembly_name})`)
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

    const thClass = `px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide ${isLight ? 'text-gray-500 bg-gray-50' : 'text-gray-400 bg-gray-800'}`
    const canCaptureRasterScreenshot = typeof window !== 'undefined' &&
        typeof window.electronAPI?.captureHtmlSnapshot === 'function'
    const screenshotTarget = useMemo(() => {
        const node = screenshotRootNode
        if (!node) return null
        const allowedFormats = canCaptureRasterScreenshot ? ['svg', 'png', 'jpeg'] : ['svg']
        return {
            id: 'species-selector-view',
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
        onScreenshotAvailabilityChange?.('species_selector', Boolean(screenshotTarget))
        return () => onScreenshotAvailabilityChange?.('species_selector', false)
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
            />
            <CustomAnnotationModal
                isOpen={!!customAnnotationTarget}
                theme={theme}
                item={customAnnotationTarget}
                label={customAnnotationLabel}
                path={customAnnotationPath}
                importing={importingCustomAnnotation}
                onLabelChange={setCustomAnnotationLabel}
                onPathChange={setCustomAnnotationPath}
                onBrowse={() => {
                    setModalTarget('custom_annotation_gff3')
                    setModalMode('file')
                    setModalOpen(true)
                }}
                onCancel={closeCustomAnnotationModal}
                onImport={importCustomAnnotation}
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
                    <div className="flex items-center gap-3">
                        {statusMessage.isError
                            ? <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
                            : <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" strokeLinecap="round" strokeLinejoin="round" /><polyline points="22 4 12 14.01 9 11.01" strokeLinecap="round" strokeLinejoin="round" /></svg>
                        }
                        <span className="font-medium">{statusMessage.text}</span>
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
                <button
                    type="button"
                    onClick={() => setManualOpen((prev) => !prev)}
                    className={`w-full flex items-center justify-between px-6 py-4 text-left transition-colors ${isLight ? 'hover:bg-gray-50' : 'hover:bg-gray-750'}`}
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
                        className={`transition-transform ${manualOpen ? 'rotate-180' : ''} ${isLight ? 'text-gray-400' : 'text-gray-500'}`}
                    >
                        <path d="M4 6l4 4 4-4" />
                    </svg>
                </button>

                {manualOpen && (
                    <div className={`px-6 pb-6 border-t ${isLight ? 'border-gray-100' : 'border-gray-700'}`}>
                        <div className="pt-5 space-y-4">
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                                <div>
                                    <label className={`block text-xs font-semibold mb-1.5 uppercase tracking-wide ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                        Species label *
                                    </label>
                                    <input
                                        type="text"
                                        value={manualSpeciesLabel}
                                        onChange={(e) => setManualSpeciesLabel(e.target.value)}
                                        placeholder="e.g. Homo sapiens"
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

                            <div>
                                <label className={`block text-xs font-semibold mb-1.5 uppercase tracking-wide ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                    Genome directory (auto-detect)
                                </label>
                                <div className="flex items-center gap-2">
                                    <input
                                        type="text"
                                        value={manualDirectory || ''}
                                        readOnly
                                        placeholder="/path/to/genome/files"
                                        className={`flex-1 px-3 py-2 rounded-lg text-xs border font-mono ${isLight
                                            ? 'bg-gray-50 border-gray-300 text-gray-800 placeholder-gray-400'
                                            : 'bg-gray-900 border-gray-600 text-gray-200 placeholder-gray-500'
                                            }`}
                                    />
                                    <button
                                        type="button"
                                        onClick={() => openManualBrowser('manual_directory', 'directory')}
                                        className={`px-3 py-2 rounded-lg text-xs font-semibold transition-colors ${isLight
                                            ? 'bg-gray-100 text-gray-700 hover:bg-gray-200 border border-gray-300'
                                            : 'bg-gray-700 text-gray-200 hover:bg-gray-600 border border-gray-500'
                                            }`}
                                    >
                                        Browse
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => autodetectDirectory(manualDirectory)}
                                        disabled={!manualDirectory || detectingDirectory}
                                        className={`px-3 py-2 rounded-lg text-xs font-semibold transition-colors ${isLight
                                            ? 'bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-200 disabled:bg-gray-100 disabled:text-gray-400 disabled:border-gray-200'
                                            : 'bg-blue-900/30 text-blue-300 hover:bg-blue-900/50 border border-blue-700/40 disabled:bg-gray-800 disabled:text-gray-500 disabled:border-gray-700'
                                            }`}
                                    >
                                        {detectingDirectory ? 'Scanning…' : 'Auto-detect'}
                                    </button>
                                </div>
                            </div>

                            {manualWarnings.length > 0 && (
                                <div className={`rounded-lg px-3 py-2 text-xs ${isLight ? 'bg-amber-50 text-amber-800 border border-amber-200' : 'bg-amber-900/20 text-amber-300 border border-amber-800/40'}`}>
                                    {manualWarnings.map((message, idx) => (
                                        <div key={`${message}-${idx}`}>{message}</div>
                                    ))}
                                </div>
                            )}

                            <ManualPathRow
                                label="FASTA file"
                                value={manualFasta}
                                onBrowse={() => openManualBrowser('manual_fasta', 'file')}
                                placeholder="/path/to/genome.fa.gz"
                                isLight={isLight}
                            />

                            <ManualPathRow
                                label="GFF3 file"
                                value={manualGff3}
                                onBrowse={() => openManualBrowser('manual_gff3', 'file')}
                                placeholder="/path/to/genes.gff3.gz"
                                isLight={isLight}
                            />

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
                                <input
                                    type="text"
                                    value={manualIndexPath || ''}
                                    readOnly
                                    placeholder="Will be set when GFF3 is selected"
                                    className={`w-full px-3 py-2 rounded-lg text-xs border font-mono ${isLight
                                        ? 'bg-gray-50 border-gray-300 text-gray-800 placeholder-gray-400'
                                        : 'bg-gray-900 border-gray-600 text-gray-200 placeholder-gray-500'
                                        }`}
                                />
                                <p className={`mt-1 text-xs ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                    Index filename uses the GFF3 basename with a `.gff3.index.db` suffix.
                                </p>
                            </div>

                            <div className="flex justify-end">
                                <button
                                    type="button"
                                    onClick={addManualGenome}
                                    disabled={!manualSpeciesLabel.trim() || !manualAssemblyLabel.trim() || !manualFasta || !manualGff3}
                                    className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${isLight
                                        ? 'bg-[#0099ff] text-white hover:bg-[#0088ee] disabled:bg-gray-300 disabled:cursor-not-allowed'
                                        : 'bg-blue-600 text-white hover:bg-blue-500 disabled:bg-gray-700 disabled:cursor-not-allowed'
                                        }`}
                                >
                                    Add genome
                                </button>
                            </div>
                        </div>
                    </div>
                )}
            </div>

            <div className={`order-2 flex-none h-[560px] min-h-[560px] rounded-xl border overflow-hidden flex flex-col ${isLight ? 'bg-white border-gray-200 shadow-sm' : 'bg-gray-800 border-gray-700'}`}>
                {loading ? (
                    <div className="flex-1 flex items-center justify-center">
                        <div className={`animate-spin w-8 h-8 border-4 border-t-transparent rounded-full ${isLight ? 'border-blue-500' : 'border-blue-400'}`}></div>
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
                                        <th className={`${thClass} w-16 text-center`}>Active</th>
                                        <th className={thClass}>Species</th>
                                        <th className={thClass}>Source</th>
                                        <th className={thClass}>Accession</th>
                                        <th className={thClass}>Assembly</th>
                                        <th className={thClass}>Files</th>
                                        <th className={thClass}>Index</th>
                                        <th className={`${thClass} w-32 min-w-[8rem] text-center`}>Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
	                                    {pageItems.map((item) => {
	                                        const key = itemKey(item)
	                                        const rowKey = String(item?.assembly_key || key || '').trim()
	                                        const isMissing = Boolean(item?.is_missing)
	                                        const isSelected = selectedGenomeKeys.has(key)
		                                        const isPendingSelection = pendingSelectionKeys.has(key)
		                                        const effectiveFiles = getEffectiveFiles(item)
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
                                                onClick={() => !isMissing && toggleSpecies(item)}
                                                className={`border-b transition-colors group ${isMissing
                                                    ? (isLight ? 'bg-gray-50/80 border-gray-100' : 'bg-gray-900/20 border-gray-700/50')
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
                                                        className={`w-5 h-5 rounded border-gray-300 text-blue-600 focus:ring-blue-500 ${isMissing ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'}`}
                                                    />
                                                </td>
                                                <td className={`px-4 py-3 align-middle ${isMissing
                                                    ? (isLight ? 'text-gray-500' : 'text-gray-400')
                                                    : (isLight ? 'text-gray-900' : 'text-gray-100')
                                                    }`}>
                                                    <div className="font-medium leading-tight flex items-center gap-2">
                                                        <span>{item.scientific_name}</span>
                                                        {item.is_manual && (
                                                            <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${isLight ? 'bg-indigo-100 text-indigo-700' : 'bg-indigo-900/40 text-indigo-300'}`}>
                                                                Manual
                                                            </span>
                                                        )}
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
                                                    ) : confirmDelete === key ? (
                                                        <div className="flex items-center justify-center gap-2">
                                                            <button
                                                                type="button"
                                                                onMouseDown={(event) => {
                                                                    event.preventDefault()
                                                                    event.stopPropagation()
                                                                }}
                                                                onClick={() => handleDelete(item)}
                                                                className={`px-3 py-1.5 rounded text-[11px] font-bold uppercase tracking-wide ${isLight
                                                                    ? 'bg-red-100 text-red-700 hover:bg-red-200'
                                                                    : 'bg-red-900/40 text-red-400 hover:bg-red-900/60'
                                                                    }`}
                                                            >
                                                                Delete
                                                            </button>
                                                            <button
                                                                type="button"
                                                                onMouseDown={(event) => {
                                                                    event.preventDefault()
                                                                    event.stopPropagation()
                                                                }}
                                                                onClick={() => setConfirmDelete(null)}
                                                                className={`px-3 py-1.5 rounded text-[11px] font-bold uppercase tracking-wide ${isLight
                                                                    ? 'text-gray-500 hover:bg-gray-100'
                                                                    : 'text-gray-400 hover:bg-gray-700'
                                                                    }`}
                                                            >
                                                                Cancel
                                                            </button>
                                                        </div>
                                                    ) : (
	                                                        <div className="mx-auto inline-flex items-center justify-center gap-1 w-[72px]">
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
                                                                onClick={() => setConfirmDelete(key)}
                                                                className={`w-8 h-8 inline-flex items-center justify-center rounded-lg transition-colors ${isLight
                                                                    ? 'text-gray-400 hover:text-red-600 hover:bg-red-50'
                                                                    : 'text-gray-500 hover:text-red-400 hover:bg-red-900/20'
                                                                    }`}
                                                                title={item.is_manual ? 'Remove manual genome' : 'Delete local files'}
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
                                                            <div className="space-y-2">
                                                                <div className={`text-xs font-bold uppercase tracking-widest ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                                                    Default dataset file paths
                                                                </div>
                                                                <GenomeFileEditor
                                                                    item={item}
                                                                    effectiveFiles={effectiveFiles}
                                                                    isLight={isLight}
                                                                    confirmDeleteFile={confirmDeleteFile}
                                                                    setConfirmDeleteFile={setConfirmDeleteFile}
                                                                    onDeleteFile={handleDeleteSingleFile}
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

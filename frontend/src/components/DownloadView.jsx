import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { API_BASE } from '../backendRuntime'
import useTutorial from '../hooks/useTutorial'
import { isDemoGenomeItem } from '../tutorials/demoGenome'
import { fetchDemoGenomeStatus, installDemoGenome } from '../tutorials/demoGenomeApi'
import ScreenshotExportModal from './ScreenshotExportModal'
import ScreenshotSelectionOverlay from './ScreenshotSelectionOverlay'
import ProgressGlyph from './ProgressGlyph'
import { DownloadMark } from './appIconMarks'
import {
    buildDefaultScreenshotName,
    buildDomNodeScreenshotSnapshot,
    measureScreenshotNode,
} from '../utils/screenshotExport'
import {
    getAssemblyAccession,
    getAssemblyGenomeKey,
    normalizeGenomeProvider,
    normalizeGenomeRecord,
    normalizeGenomeSourceDatabase,
} from '../utils/genomeIdentity'
import { datasetReleaseDownloadMetadata } from '../utils/downloadMetadata'
import {
    DOWNLOAD_FILE_DEFS,
    fileTypeLabel,
    fileTypeTooltip,
} from '../utils/genomeFileTypes'

const PAGE_SIZE = 50
const DL_PAGE_SIZE = 10
const SELECTOR_PENDING_GENOMES_STORAGE_KEY = 'ensembl_selector_pending_genomes'
const SELECTOR_REFRESH_EVENT = 'ensembl:selector-refresh'

// Groups that form the "Vertebrates" super-category in the sidebar
const VERTEBRATE_GROUPS = new Set(['Mammals', 'Fish', 'Birds', 'Reptiles', 'Amphibians'])
const REFSEQ_INVERTEBRATE_GROUPS = new Set(['Insects', 'Nematodes'])
const REFSEQ_MICROBE_GROUPS = new Set(['Bacteria', 'Archaea'])
const REFSEQ_FEATURED_ACCESSIONS = new Set([
    'GCF_000001405.40',
    'GCF_000001405.25',
    'GCF_009914755.1',
    'GCF_000001635.9',
    'GCF_036323735.1',
    'GCF_000002315.6',
    'GCF_000002035.6',
    'GCF_002234675.1',
    'GCF_000001215.4',
    'GCF_000005575.2',
    'GCF_000002765.6',
    'GCF_000001735.4',
    'GCF_001433935.1',
    'GCA_900519105.1',
    'GCF_000002985.6',
    'GCF_000146045.2',
    'GCF_000005845.2',
])

// Specific model organisms to highlight at the top of the list
const MODEL_ORGANISMS = [
    { key: 'Homo_sapiens', gca: 'GCA_000001405.29' }, // GRCh38
    { key: 'Homo_sapiens', gca: 'GCA_000001405.14' }, // GRCh37
    { key: 'Homo_sapiens', gca: 'GCA_009914755.4' },  // CHM13
    { key: 'Mus_musculus', gca: 'GCA_000001635.9' },  // GRCm39
    { key: 'Rattus_norvegicus', gca: 'GCA_036323735.1' }, // GRCr8
    { key: 'Gallus_gallus', gca: 'GCA_000002315.5' }, // GRCg6a
    { key: 'Danio_rerio', gca: 'GCA_000002035.4' }, // GRCz11
    { key: 'Oryzias_latipes', gca: 'GCA_002234675.1' }, // ASM223467v1
    { key: 'Drosophila_melanogaster', gca: 'GCA_000001215.4' }, // BDGP6.54
    { key: 'Anopheles_gambiae', gca: 'GCA_000005575.1' }, // AgamP3
    { key: 'Plasmodium_falciparum_3D7', gca: 'GCA_000002765.2' }, // ASM276v2
    { key: 'Arabidopsis_thaliana', gca: 'GCA_000001735.1' }, // TAIR10
    { key: 'Oryza_sativa_Japonica_Group', gca: 'GCA_001433935.1' }, // IRGSP-1.0
    { key: 'Triticum_aestivum', gca: 'GCA_900519105.1' }, // IWGSC
    { key: 'Caenorhabditis_elegans', gca: 'GCA_000002985.3' }, // WBcel235
    { key: 'Saccharomyces_cerevisiae_S288c', gca: 'GCA_000146045.2' }, // R64-1-1
    { key: 'Escherichia_coli_str_K_12_substr_MG1655_str_K12', gca: 'GCA_000005845.2' }, // ASM584v2
]

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------
const IconUpDown = ({ open, size = 12 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
        style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}>
        <polyline points="6 9 12 15 18 9" />
    </svg>
)
const IconDownload = ({ size = 16, progress = null }) => (
    <ProgressGlyph size={size} progress={progress} renderGlyph={(props) => <DownloadMark {...props} />} />
)
const IconDownloaded = ({ size = 16 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10.4" />
        <path d="M7 12.4l3.1 3.1L17.4 8.2" />
    </svg>
)
const IconFiles = ({ size = 16 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <path d="M14 2v6h6" />
        <path d="M8 13h8M8 17h5" />
    </svg>
)
const IconTrash = ({ size = 14 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <polyline points="3 6 5 6 21 6" />
        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
        <path d="M10 11v6M14 11v6" />
    </svg>
)
const IconSearch = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
)

const taskStatusPriority = (task) => {
    const status = String(task?.status || '')
    if (status === 'downloading') return 4
    if (status === 'pending') return 3
    if (status === 'completed') return 2
    if (status === 'failed') return 1
    return 0
}

const pickPreferredTask = (tasks) => {
    let best = null
    for (const task of Array.isArray(tasks) ? tasks : []) {
        if (!best) {
            best = task
            continue
        }
        const currentPriority = taskStatusPriority(task)
        const bestPriority = taskStatusPriority(best)
        if (currentPriority > bestPriority || currentPriority === bestPriority) {
            best = task
        }
    }
    return best
}

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
        // ignore session storage failures
    }
}

const formatCatalogTimestamp = (value) => {
    const raw = String(value || '').trim()
    if (!raw) return 'Not checked yet'
    const parsed = new Date(raw)
    if (Number.isNaN(parsed.getTime())) return 'Not checked yet'
    return parsed.toLocaleString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    })
}

const buildCatalogChangeMessage = (latestChange) => {
    if (!latestChange) return ''
    const parts = []
    const addedCount = Number(latestChange.added_count || 0)
    const retiredCount = Number(latestChange.retired_count || 0)
    if (addedCount > 0) parts.push(`${addedCount} new genome${addedCount === 1 ? '' : 's'} added`)
    if (retiredCount > 0) parts.push(`${retiredCount} genome${retiredCount === 1 ? '' : 's'} retired upstream`)
    return parts.join(' • ')
}

const formatSpeciesNameFromKey = (value) => String(value || '').trim().replace(/_/g, ' ')

const normalizeRemoteAssembly = (assembly, provider) => {
    const normalizedProvider = normalizeGenomeProvider(assembly?.provider || provider)
    const accession = getAssemblyAccession(assembly)
    return {
        ...assembly,
        provider: normalizedProvider,
        accession,
        gca: String(assembly?.gca || accession || '').trim(),
        source_database: normalizeGenomeSourceDatabase({ ...assembly, provider: normalizedProvider, assembly: accession }),
    }
}

const normalizeRemoteSpecies = (species, fallbackProvider) => {
    const provider = normalizeGenomeProvider(species?.provider || fallbackProvider)
    return {
        ...species,
        provider,
        assemblies: Array.isArray(species?.assemblies)
            ? species.assemblies.map((assembly) => normalizeRemoteAssembly(assembly, provider))
            : [],
    }
}

const matchesModelOrganism = (speciesKey, assembly) => {
    const accession = getAssemblyAccession(assembly)
    return MODEL_ORGANISMS.some((item) => item.key === speciesKey && item.gca === accession)
}

const NCBI_EXAMPLE_ORGANISMS = [
    { key: 'Homo_sapiens', accession: 'GCA_000001405.29', assembly_name: 'GRCh38' },
    { key: 'Homo_sapiens', accession: 'GCA_009914755.4', assembly_name: 'T2T-CHM13v2.0' },
    { key: 'Mus_musculus', accession: 'GCF_000001635.27', assembly_name: 'GRCm39' },
    { key: 'Rattus_norvegicus', accession: 'GCA_036323735.1', assembly_name: 'GRCr8' },
    { key: 'Gallus_gallus', accession: 'GCA_000002315.5', assembly_name: 'GRCg6a' },
    { key: 'Danio_rerio', accession: 'GCA_000002035.4', assembly_name: 'GRCz11' },
    { key: 'Drosophila_melanogaster', accession: 'GCA_000001215.4', assembly_name: 'BDGP6.54' },
    { key: 'Arabidopsis_thaliana', accession: 'GCA_000001735.1', assembly_name: 'TAIR10' },
    { key: 'Caenorhabditis_elegans', accession: 'GCA_000002985.3', assembly_name: 'WBcel235' },
    { key: 'Saccharomyces_cerevisiae_S288c', accession: 'GCA_000146045.2', assembly_name: 'R64-1-1' },
]

const buildNcbiExampleSpecies = () => {
    return NCBI_EXAMPLE_ORGANISMS.map((item) => normalizeRemoteSpecies({
        key: item.key,
        scientific_name: formatSpeciesNameFromKey(item.key),
        common_name: '',
        taxid: 0,
        species_taxonomy_id: 0,
        group: '',
        sub_group: null,
        provider: 'ncbi',
        assemblies: [
            {
                accession: item.accession,
                gca: item.accession,
                assembly: item.accession,
                name: item.assembly_name,
                source_database: normalizeGenomeSourceDatabase({ provider: 'ncbi', assembly: item.accession }),
                equivalent_accessions: [],
            },
        ],
    }, 'ncbi'))
}

const NCBI_EXAMPLE_SPECIES = buildNcbiExampleSpecies()

// ---------------------------------------------------------------------------
// File type status badge — shows download progress inline
// ---------------------------------------------------------------------------
const ENSEMBL_DOWNLOAD_FILE_TYPES = ['fasta', 'gff3', 'homology', 'cdna', 'protein', 'xref']
const REFSEQ_DOWNLOAD_FILE_TYPES = ['fasta', 'gff3']
const DEFAULT_DOWNLOAD_FILE_TYPES = ['fasta', 'gff3']
const DATASET_DOWNLOAD_TYPES = new Set(['gff3', 'homology', 'cdna', 'protein', 'xref', 'gff3_index', 'gtf_index', 'cdna_index', 'protein_index', 'xref_index', 'gtf', 'embl', 'alignment', 'other_annotation'])
const ASSEMBLY_DOWNLOAD_TYPES = new Set(['fasta', 'metadata'])

const selectedDownloadTypeList = (selectedTypes) => (
    Array.from(selectedTypes || []).filter((type) => type && type !== 'metadata')
)
const withImplicitMetadataTypes = (types) => {
    const selected = Array.from(types || []).map((type) => String(type || '').trim()).filter(Boolean)
    if (selected.includes('fasta') || selected.includes('gff3')) selected.push('metadata')
    return [...new Set(selected)]
}
const missingSelectedDownloadTypes = (selectedTypes, localTypes) => {
    const local = new Set((Array.isArray(localTypes) ? localTypes : []).map((type) => String(type || '').trim()).filter(Boolean))
    return selectedDownloadTypeList(selectedTypes).filter((type) => !local.has(type))
}
const fileDisplayParts = (file) => {
    const def = DOWNLOAD_FILE_DEFS[file?.type] || {}
    return {
        category: def.category || 'File',
        subtype: def.subtype || fileTypeLabel(file?.type),
        filename: String(file?.filename || ''),
    }
}

const PRIMARY_DATASET_LABELS = {
    gff3: 'Genes',
    homology: 'Homologies',
    cdna: 'Transcripts',
    protein: 'Proteins',
    xref: 'Xrefs',
}

const primaryDatasetTypeOrder = ['gff3', 'homology', 'cdna', 'protein', 'xref']

const selectAssemblyDisplayFiles = (files) => {
    const fastaFiles = (Array.isArray(files) ? files : []).filter((file) => file?.type === 'fasta')
    if (fastaFiles.length === 0) return []
    const selected = fastaFiles.find((file) => file?.selected_by_default)
    const softmasked = fastaFiles.find((file) => /softmask/i.test(`${file?.filename || ''} ${file?.url || ''}`))
    return [selected || softmasked || fastaFiles[0]]
}

const selectPrimaryDatasetFiles = (files) => {
    const releaseFiles = Array.isArray(files) ? files : []
    return primaryDatasetTypeOrder
        .map((type) => {
            const candidates = releaseFiles.filter((file) => file?.type === type)
            return candidates.find((file) => file?.selected_by_default) || candidates[0] || null
        })
        .filter(Boolean)
}

const fileSubjectLabel = (file) => {
    const type = String(file?.type || '')
    const parentType = String(file?.parent_type || '')
    if (type === 'embl') return 'EMBL'
    if (type === 'homology' || parentType === 'homology') return 'Homologies'
    if (type === 'cdna' || parentType === 'cdna') return 'Transcripts'
    if (type === 'protein' || parentType === 'protein') return 'Proteins'
    if (type === 'xref' || parentType === 'xref') return 'Xrefs'
    if (['gff3', 'gtf', 'other_annotation'].includes(type) || ['gff3', 'gtf'].includes(parentType)) return 'Genes'
    return fileDisplayParts(file).category
}

const fileIndexSubjectLabel = (file) => {
    const type = String(file?.type || '')
    const parentType = String(file?.parent_type || '')
    if (type === 'protein_index' || parentType === 'protein') return 'Protein'
    if (type === 'cdna_index' || parentType === 'cdna') return 'Transcript'
    if (type === 'xref_index' || parentType === 'xref') return 'Xref'
    if (type === 'homology_index' || parentType === 'homology') return 'Homology'
    if (type === 'gff3_index' || type === 'gtf_index' || ['gff3', 'gtf'].includes(parentType)) return 'Genes'
    return fileSubjectLabel(file)
}

const alignmentFileLabel = (file) => {
    const species = String(file?.other_species_name || '').trim() || 'Other species'
    const accession = String(file?.other_species_gca || file?.other_species_gcf || file?.other_accession || '').trim()
    const alignmentType = String(file?.alignment_type || '').trim()
    return [species, accession, alignmentType].filter(Boolean).join(' - ')
}

const compactFileLabel = (file, primary = false) => {
    if (primary) return PRIMARY_DATASET_LABELS[file?.type] || fileSubjectLabel(file)
    if (file?.type === 'alignment') return alignmentFileLabel(file)
    if (file?.is_index || String(file?.type || '').endsWith('_index')) {
        const subject = fileIndexSubjectLabel(file)
        return `${subject} Index`
    }
    return fileSubjectLabel(file)
}

const sortFilesByCompactLabel = (files) => {
    return [...(Array.isArray(files) ? files : [])].sort((a, b) => {
        const labelCompare = compactFileLabel(a).localeCompare(compactFileLabel(b), undefined, { numeric: true, sensitivity: 'base' })
        if (labelCompare !== 0) return labelCompare
        return String(a?.filename || '').localeCompare(String(b?.filename || ''), undefined, { numeric: true, sensitivity: 'base' })
    })
}

const withRequiredMetadataFiles = (files, allFiles) => {
    const selected = Array.isArray(files) ? [...files] : []
    const hasSelected = selected.length > 0
    const metadataFiles = (Array.isArray(allFiles) ? allFiles : []).filter((file) => file?.type === 'metadata')
    if (!hasSelected || metadataFiles.length === 0) return selected
    const seen = new Set(selected.map(availabilityFileId))
    for (const file of metadataFiles) {
        const id = availabilityFileId(file)
        if (!seen.has(id)) {
            selected.push(file)
            seen.add(id)
        }
    }
    return selected
}

const sortAvailabilityReleases = (releases) => {
    const raw = Array.isArray(releases) ? releases : []
    return [...raw].sort((a, b) => {
        const aIsCompara = String(a?.source || '').toLowerCase() === 'ensembl_compara'
        const bIsCompara = String(b?.source || '').toLowerCase() === 'ensembl_compara'
        if (aIsCompara !== bIsCompara) return aIsCompara ? 1 : -1
        if (a?.is_default && !b?.is_default) return -1
        if (!a?.is_default && b?.is_default) return 1
        return String(b?.date || b?.key || '').localeCompare(String(a?.date || a?.key || ''), undefined, { numeric: true, sensitivity: 'base' })
    })
}

function FileStatusBadge({ type, itemTasks, isLocal, onRetry }) {
    // Prefer active/completed task states over stale failed attempts for the same type.
    const tasksForType = itemTasks?.filter(t => t.file_type === type) || []
    const task = pickPreferredTask(tasksForType) || undefined

    const base = DOWNLOAD_FILE_DEFS[type]?.color || 'bg-gray-100 text-gray-700'

    let ringClass = ''
    let suffix = null
    const isFailed = task?.status === 'failed'
    const hasWarning = task?.status === 'completed' && String(task?.warning || '').trim().length > 0
    const isRetryable = isFailed && typeof onRetry === 'function'

    if (task) {
        if (task.status === 'completed') {
            if (isLocal) {
                ringClass = 'ring-1 ring-green-500'
                suffix = <span className="text-green-600 font-bold ml-0.5">✓</span>
            } else {
                // Completed task but file not present locally (e.g., file deleted later).
                ringClass = ''
                suffix = null
            }
        } else if (isFailed) {
            ringClass = 'ring-1 ring-orange-400'
            suffix = <span className="text-orange-500 font-bold ml-0.5">{isRetryable ? '↺' : '!'}</span>
        } else if (task.status === 'downloading') {
            ringClass = 'ring-1 ring-blue-400 animate-pulse'
            suffix = <span className="text-blue-600 ml-0.5">{Math.round((task.progress || 0) * 100)}%</span>
        } else {
            // pending
            suffix = <span className="text-gray-400 ml-0.5">⋯</span>
        }
    } else if (isLocal) {
        // File already exists on disk (no active task)
        ringClass = 'ring-1 ring-green-500'
        suffix = <span className="text-green-600 font-bold ml-0.5">✓</span>
    }

    return (
        <span
            className={`inline-flex items-center text-[10px] px-1.5 py-0.5 rounded font-bold uppercase ${base} ${ringClass} ${isRetryable ? 'cursor-pointer hover:opacity-75' : ''}`}
            title={isRetryable
                ? `Retry ${fileTypeLabel(type)} download`
                : (hasWarning
                    ? String(task?.warning || '')
                    : (isLocal && !task ? `${fileTypeTooltip(type)} Already downloaded locally.` : fileTypeTooltip(type)))}
            onClick={isRetryable ? () => onRetry(type) : undefined}
        >
            {fileTypeLabel(type)}{suffix}
        </span>
    )
}

// ---------------------------------------------------------------------------
// Group sidebar
// ---------------------------------------------------------------------------
function GroupBrowser({ groups, totalAssemblies, activeGroup, activeSubGroup, onSelectGroup, onSelectSubGroup, isLight }) {
    const [expandedGroups, setExpandedGroups] = useState({})
    const toggleGroup = (name) => setExpandedGroups(prev => ({ ...prev, [name]: !prev[name] }))
    const totalSpecies = groups
        .filter(g => g.name !== 'Models' && g.name !== 'Local genomes' && g.name !== 'Projects')
        .reduce((s, g) => s + g.count, 0)

    // Split groups into vertebrates vs others
    const vertebrateGroups = groups.filter(g => VERTEBRATE_GROUPS.has(g.name))
    const projectGroup = groups.find(g => g.name === 'Projects')
    const otherGroups = groups.filter(g => !VERTEBRATE_GROUPS.has(g.name) && g.name !== 'Models' && g.name !== 'Local genomes' && g.name !== 'Projects')
    const localGenomesGroup = groups.find(g => g.name === 'Local genomes')
    const vertebrateCount = vertebrateGroups.reduce((s, g) => s + g.count, 0)

    const itemBase = `flex items-center justify-between px-3 py-1.5 rounded-md cursor-pointer text-sm transition-colors`
    const activeStyle = isLight ? 'bg-blue-100 text-blue-800 font-semibold' : 'bg-blue-900/40 text-blue-300 font-semibold'
    const inactiveStyle = isLight ? 'text-gray-700 hover:bg-gray-100' : 'text-gray-300 hover:bg-gray-700/50'

    const isVertActive = activeGroup === 'Vertebrates' || (VERTEBRATE_GROUPS.has(activeGroup) && !activeSubGroup)
    const isModelsActive = activeGroup === 'Models'

    // Renders a single group row (with optional indent and expandable subgroups)
    const renderGroup = (group, indent = 0) => {
        const isActive = activeGroup === group.name && !activeSubGroup
        const hasSubGroups = group.sub_groups?.length > 0
        return (
            <div key={group.name}>
                <div
                    className={`${itemBase} ${isActive ? activeStyle : inactiveStyle}`}
                    style={indent ? { paddingLeft: `${indent}rem` } : undefined}
                    onClick={() => {
                        onSelectGroup(group.name)
                        onSelectSubGroup(null)
                        if (hasSubGroups) toggleGroup(group.name)
                    }}
                >
                    <span>{group.name}</span>
                    <span className="flex items-center">
                        <span className={`text-xs tabular-nums w-10 text-right ${isActive ? '' : 'opacity-50'}`}>{group.count}</span>
                        <span className="w-4 flex justify-center">
                            {hasSubGroups && (
                                <span className="opacity-50"><IconUpDown open={expandedGroups[group.name]} /></span>
                            )}
                        </span>
                    </span>
                </div>

                {expandedGroups[group.name] && group.sub_groups?.map(sg => (
                    <div
                        key={sg.name}
                        onClick={() => { onSelectGroup(group.name); onSelectSubGroup(sg.name) }}
                        className={`${itemBase} ${activeGroup === group.name && activeSubGroup === sg.name ? activeStyle : inactiveStyle}`}
                        style={{ paddingLeft: `${(indent || 0.75) + 1}rem` }}
                    >
                        <span>{sg.name}</span>
                        <span className="flex items-center">
                            <span className={`text-xs tabular-nums w-10 text-right ${activeSubGroup === sg.name ? '' : 'opacity-50'}`}>{sg.count}</span>
                            <span className="w-4" />
                        </span>
                    </div>
                ))}
            </div>
        )
    }

    return (
        <div className="flex flex-col gap-0.5 overflow-y-auto">
            {/* All Species */}
            <div
                onClick={() => { onSelectGroup('All'); onSelectSubGroup(null) }}
                className={`${itemBase} ${activeGroup === 'All' ? activeStyle : inactiveStyle}`}
            >
                <span>All Species</span>
                <span className="flex items-center">
                    <span className={`text-xs tabular-nums w-10 text-right ${activeGroup === 'All' ? '' : 'opacity-50'}`}>{totalSpecies}</span>
                    <span className="w-4" />
                </span>
            </div>

            {/* All Assemblies */}
            <div className={`${itemBase} pointer-events-none`}>
                <span className={`text-xs ${isLight ? 'text-gray-400' : 'text-gray-500'}`}>All Assemblies</span>
                <span className="flex items-center">
                    <span className={`text-xs tabular-nums w-10 text-right opacity-50`}>{totalAssemblies}</span>
                    <span className="w-4" />
                </span>
            </div>

            <div className={`my-1 border-t ${isLight ? 'border-gray-200' : 'border-gray-700'}`} />

            {localGenomesGroup && (
                <>
                    <div
                        onClick={() => { onSelectGroup('Local genomes'); onSelectSubGroup(null) }}
                        className={`${itemBase} ${activeGroup === 'Local genomes' ? activeStyle : inactiveStyle}`}
                    >
                        <span>Local genomes</span>
                        <span className="flex items-center">
                            <span className={`text-xs tabular-nums w-10 text-right ${activeGroup === 'Local genomes' ? '' : 'opacity-50'}`}>
                                {localGenomesGroup.count}
                            </span>
                            <span className="w-4" />
                        </span>
                    </div>
                    <div className={`my-1 border-t ${isLight ? 'border-gray-200' : 'border-gray-700'}`} />
                </>
            )}

            {/* Models group */}
            {groups.find(g => g.name === 'Models') && (
                <div
                    onClick={() => { onSelectGroup('Models'); onSelectSubGroup(null) }}
                    className={`${itemBase} ${isModelsActive ? activeStyle : inactiveStyle}`}
                >
                    <span>Models</span>
                    <span className="flex items-center">
                        <span className={`text-xs tabular-nums w-10 text-right ${isModelsActive ? '' : 'opacity-50'}`}>
                            {groups.find(g => g.name === 'Models')?.count || 0}
                        </span>
                        <span className="w-4" />
                    </span>
                </div>
            )}

            {/* Vertebrates super-group */}
            {vertebrateGroups.length > 0 && (
                <div>
                    <div
                        className={`${itemBase} ${activeGroup === 'Vertebrates' && !activeSubGroup ? activeStyle : inactiveStyle}`}
                        onClick={() => {
                            onSelectGroup('Vertebrates')
                            onSelectSubGroup(null)
                            toggleGroup('Vertebrates')
                        }}
                    >
                        <span>Vertebrates</span>
                        <span className="flex items-center">
                            <span className={`text-xs tabular-nums w-10 text-right ${isVertActive ? '' : 'opacity-50'}`}>{vertebrateCount}</span>
                            <span className="w-4 flex justify-center">
                                <span className="opacity-50"><IconUpDown open={expandedGroups['Vertebrates']} /></span>
                            </span>
                        </span>
                    </div>

                    {expandedGroups['Vertebrates'] && vertebrateGroups.map(g => renderGroup(g, 1.25))}
                </div>
            )}

            {/* Non-vertebrate groups */}
            {otherGroups.map(g => renderGroup(g))}

            {/* Project membership group */}
            {projectGroup && (
                <>
                    <div className={`my-1 border-t ${isLight ? 'border-gray-200' : 'border-gray-700'}`} />
                    {renderGroup(projectGroup)}
                </>
            )}

        </div>
    )
}

// ---------------------------------------------------------------------------
// RefSeqGroupBrowser — sidebar group browser for the RefSeq tab
// ---------------------------------------------------------------------------

function RefSeqGroupBrowser({ groups, activeGroup, activeSubGroup, onSelectGroup, onSelectSubGroup, isLight, loading }) {
    const [expandedGroups, setExpandedGroups] = useState({ Vertebrates: true })
    const toggleGroup = (name) => setExpandedGroups(prev => ({ ...prev, [name]: !prev[name] }))

    const itemBase = `flex items-center justify-between px-3 py-1.5 rounded-md cursor-pointer text-sm transition-colors`
    const activeStyle = isLight ? 'bg-blue-100 text-blue-800 font-semibold' : 'bg-blue-900/40 text-blue-300 font-semibold'
    const inactiveStyle = isLight ? 'text-gray-700 hover:bg-gray-100' : 'text-gray-300 hover:bg-gray-700/50'

    const countFor = (name) => {
        const g = groups.find(g => g.name === name)
        return g ? g.count : null
    }
    const subCountFor = (parentName, childName) => {
        const g = groups.find(g => g.name === parentName)
        const sg = g?.sub_groups?.find(s => s.name === childName)
        return sg != null ? sg.count : null
    }

    const countBadge = (count, isActive) => (
        <span className={`text-xs tabular-nums min-w-[3.5rem] pr-1 text-right shrink-0 ${isActive ? '' : 'opacity-50'}`}>
            {loading ? '…' : (count === null ? '…' : count)}
        </span>
    )

    const renderLeaf = (name, indent = 0) => {
        const isActive = activeGroup === name && !activeSubGroup
        return (
            <div
                key={name}
                className={`${itemBase} ${isActive ? activeStyle : inactiveStyle}`}
                style={indent ? { paddingLeft: `${indent}rem` } : undefined}
                onClick={() => { onSelectGroup(name); onSelectSubGroup(null) }}
            >
                <span>{name}</span>
                <span className="flex items-center">
                    {countBadge(countFor(name), isActive)}
                    <span className="w-4" />
                </span>
            </div>
        )
    }

    const renderSuperGroup = (superName, childNames, getChildCount) => {
        const isExpanded = expandedGroups[superName]
        // If the backend doesn't return a parent group by this name, derive the total from children
        const parentGroup = groups.find(g => g.name === superName)
        const totalCount = loading ? null : (
            parentGroup ? parentGroup.count : childNames.reduce((sum, n) => sum + (getChildCount(n) ?? 0), 0) || null
        )
        const childActive = childNames.includes(activeGroup) && !activeSubGroup
        const superIsActive = (activeGroup === superName && !activeSubGroup) || childActive

        return (
            <div key={superName}>
                <div
                    className={`${itemBase} ${superIsActive ? activeStyle : inactiveStyle}`}
                    onClick={() => { onSelectGroup(superName); onSelectSubGroup(null); toggleGroup(superName) }}
                >
                    <span>{superName}</span>
                    <span className="flex items-center">
                        {countBadge(totalCount, superIsActive)}
                        <span className="w-4 flex justify-center">
                            <span className="opacity-50"><IconUpDown open={isExpanded} /></span>
                        </span>
                    </span>
                </div>
                {isExpanded && childNames.map(childName => {
                    const isChildActive = activeGroup === childName && !activeSubGroup
                    return (
                        <div
                            key={childName}
                            className={`${itemBase} ${isChildActive ? activeStyle : inactiveStyle}`}
                            style={{ paddingLeft: '1.25rem' }}
                            onClick={() => { onSelectGroup(childName); onSelectSubGroup(null) }}
                        >
                            <span>{childName}</span>
                            <span className="flex items-center">
                                {countBadge(getChildCount(childName), isChildActive)}
                                <span className="w-4" />
                            </span>
                        </div>
                    )
                })}
            </div>
        )
    }

    const allGenomesActive = activeGroup === 'All genomes'
    const featuredActive = activeGroup === 'Featured'

    return (
        <div className="flex flex-col gap-0.5 overflow-y-auto">
            <div
                className={`${itemBase} ${allGenomesActive ? activeStyle : inactiveStyle}`}
                onClick={() => { onSelectGroup('All genomes'); onSelectSubGroup(null) }}
            >
                <span>All genomes</span>
                <span className="flex items-center">
                    {countBadge(countFor('All genomes'), allGenomesActive)}
                    <span className="w-4" />
                </span>
            </div>
            <div
                className={`${itemBase} ${featuredActive ? activeStyle : inactiveStyle}`}
                onClick={() => { onSelectGroup('Featured'); onSelectSubGroup(null) }}
            >
                <span>Featured</span>
                <span className="flex items-center">
                    {countBadge(countFor('Featured'), featuredActive)}
                    <span className="w-4" />
                </span>
            </div>

            <div className={`my-1 border-t ${isLight ? 'border-gray-200' : 'border-gray-700'}`} />

            {renderSuperGroup('Vertebrates', ['Mammals', 'Fish', 'Birds', 'Reptiles', 'Amphibians'],
                (n) => subCountFor('Vertebrates', n))}
            {renderSuperGroup('Invertebrates', ['Insects', 'Nematodes'],
                (n) => subCountFor('Invertebrates', n))}
            {renderLeaf('Plants')}
            {renderLeaf('Fungi')}
            {renderSuperGroup('Microbes', ['Bacteria', 'Archaea'],
                (n) => countFor(n))}
        </div>
    )
}

// ---------------------------------------------------------------------------
// Assembly list (expanded inline for multi-assembly species)
// ---------------------------------------------------------------------------
const availabilityFileId = (file) => [
    file?.scope || (DATASET_DOWNLOAD_TYPES.has(file?.type) ? 'dataset' : 'assembly'),
    file?.dataset_release_key || '',
    file?.type || '',
    file?.filename || '',
].join('::')

const gcaPrefixedDownloadFilename = (file, item) => {
    const filename = String(file?.filename || '').trim()
    const assembly = getAssemblyAccession(item)
    const type = String(file?.type || '').trim()
    if (!filename || !assembly) return filename
    if (type === 'fasta' && ['unmasked.fa.gz', 'softmasked.fa.gz', 'unmasked.fa.bgz', 'softmasked.fa.bgz'].includes(filename)) {
        return `${assembly}.${filename}`
    }
    if (type === 'gff3' && ['genes.gff3.gz', 'genes.gff3.bgz'].includes(filename)) {
        return `${assembly}.gff3${filename.endsWith('.bgz') ? '.bgz' : '.gz'}`
    }
    if (type === 'metadata' && /assembly_report\.txt$/i.test(filename)) {
        return `${assembly}.assembly_report.txt`
    }
    return filename.startsWith(assembly) ? filename : `${assembly}.${filename}`
}

const fileTaskMatches = (file, task, item) => {
    if (!file || !task) return false
    if (String(task.file_type || '') !== String(file.type || '')) return false
    const fileRelease = String(file.dataset_release_key || '')
    const taskRelease = String(task.dataset_release_key || '')
    if (fileRelease && taskRelease && fileRelease !== taskRelease) return false
    const taskFilename = String(task.filename || '').trim()
    if (!taskFilename) return true
    const sourceFilename = String(file.filename || '').trim()
    const localFilename = gcaPrefixedDownloadFilename(file, item)
    return (
        taskFilename === sourceFilename
        || taskFilename === localFilename
        || (!!sourceFilename && taskFilename.endsWith(`.${sourceFilename}`))
    )
}

const taskForAvailabilityFile = (file, itemTasks, item) => {
    const matches = (Array.isArray(itemTasks) ? itemTasks : []).filter((task) => fileTaskMatches(file, task, item))
    return pickPreferredTask(matches) || null
}

const basenameFromPath = (value) => String(value || '').split(/[\\/]/).pop() || ''

const localPathMatchesFile = (path, file, item) => {
    const basename = basenameFromPath(path)
    if (!basename) return false
    const sourceFilename = String(file?.filename || '').trim()
    const localFilename = gcaPrefixedDownloadFilename(file, item)
    return (
        basename === sourceFilename
        || basename === localFilename
        || (!!sourceFilename && basename.endsWith(`.${sourceFilename}`))
    )
}

const localFilePathForAvailabilityFile = (file, item, localFileInfo) => {
    if (!file || !localFileInfo) return ''
    const type = String(file.type || '')
    const directCandidates = []
    const assemblyFiles = localFileInfo.assembly_files || {}
    const allFiles = localFileInfo.files || {}
    const isDatasetScoped = DATASET_DOWNLOAD_TYPES.has(type)
    if (!isDatasetScoped) {
        if (assemblyFiles[type]) directCandidates.push(assemblyFiles[type])
        if (allFiles[type]) directCandidates.push(allFiles[type])
    }

    const releaseKey = String(file.dataset_release_key || '')
    const releases = Array.isArray(localFileInfo.dataset_releases) ? localFileInfo.dataset_releases : []
    const releaseCandidates = releaseKey
        ? releases.filter((release) => String(release?.key || '') === releaseKey)
        : releases.filter((release) => String(release?.key || '') === String(localFileInfo.default_dataset_release_key || localFileInfo.active_dataset_release_key || ''))
    for (const release of releaseCandidates.length > 0 ? releaseCandidates : (isDatasetScoped ? [] : releases)) {
        const files = release?.files || {}
        const sourceFilename = String(file.filename || '')
        const localFilename = gcaPrefixedDownloadFilename(file, item)
        const keyedCandidates = [
            files[`${type}::${localFilename}`],
            files[`${type}::${sourceFilename}`],
            files[type],
        ].filter(Boolean)
        directCandidates.push(...keyedCandidates)
    }

    const exact = directCandidates.find((path) => localPathMatchesFile(path, file, item))
    if (exact) return exact
    if (type !== 'alignment') return directCandidates.find(Boolean) || ''
    return ''
}

const itemFromSpeciesAssembly = (species, asm) => {
    const provider = normalizeGenomeProvider(species)
    const assembly = getAssemblyAccession(asm)
    return {
        id: getAssemblyGenomeKey({ provider, species_key: species.key, assembly }),
        provider,
        source_database: asm?.source_database || normalizeGenomeSourceDatabase({ provider, assembly }),
        species_key: species.key,
        scientific_name: species.scientific_name,
        common_name: species.common_name,
        display_name: species.display_name || '',
        display_name_reason: species.display_name_reason || '',
        assembly,
        gca: asm?.gca || assembly,
        assembly_name: asm?.name || assembly,
        equivalent_accessions: asm?.equivalent_accessions || [],
        taxid: Number(species.taxid || species.species_taxonomy_id) || 0,
    }
}

const chooseFilesForTypes = (availability, selectedTypes) => {
    const wanted = new Set(Array.isArray(selectedTypes) ? selectedTypes : [])
    if (wanted.has('fasta') || wanted.has('gff3')) wanted.add('metadata')
    const files = []
    const assemblyFiles = Array.isArray(availability?.assembly_files) ? availability.assembly_files : []
    for (const type of wanted) {
        if (!ASSEMBLY_DOWNLOAD_TYPES.has(type)) continue
        const candidates = assemblyFiles.filter((file) => file.type === type)
        if (candidates.length === 0) continue
        files.push(candidates.find((file) => file.selected_by_default) || candidates[0])
    }
    const releases = sortAvailabilityReleases(availability?.dataset_releases)
    const defaultReleaseKey = availability?.default_dataset_release_key || releases.find((release) => release?.is_default)?.key || releases[0]?.key || ''
    const release = releases.find((entry) => entry?.key === defaultReleaseKey) || releases[0]
    const releaseFiles = Array.isArray(release?.files) ? release.files : []
    for (const type of wanted) {
        if (!DATASET_DOWNLOAD_TYPES.has(type)) continue
        const candidates = releaseFiles.filter((file) => file.type === type)
        if (candidates.length === 0) continue
        files.push(candidates.find((file) => file.selected_by_default) || candidates[0])
    }
    const seen = new Set()
    return files.filter((file) => {
        const id = availabilityFileId(file)
        if (seen.has(id)) return false
        seen.add(id)
        return true
    })
}

function DownloadTypeToolbar({ activeProvider, selectedTypes, onToggleType, isLight }) {
    const allowedTypes = activeProvider === 'ncbi' ? REFSEQ_DOWNLOAD_FILE_TYPES : ENSEMBL_DOWNLOAD_FILE_TYPES
    return (
        <div data-tour-id="download-file-types" className={`px-4 py-3 border-b flex items-center gap-2 flex-wrap ${isLight ? 'bg-gray-50 border-gray-200' : 'bg-gray-750 border-gray-700'}`}>
            <span className={`text-xs font-bold uppercase tracking-widest mr-1 ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>Download</span>
            {allowedTypes.map((type) => {
                const active = selectedTypes.has(type)
                return (
                    <button
                        key={type}
                        type="button"
                        title={fileTypeTooltip(type)}
                        onClick={() => onToggleType(type)}
                        className={`px-2.5 py-1 rounded-md text-xs font-semibold border transition-colors ${active
                            ? 'bg-blue-600 text-white border-blue-600'
                            : (isLight ? 'bg-white text-gray-700 border-gray-200 hover:border-blue-300' : 'bg-gray-800 text-gray-300 border-gray-600 hover:border-blue-500')}`}
                    >
                        {DOWNLOAD_FILE_DEFS[type]?.label || type}
                    </button>
                )
            })}
            {activeProvider === 'ncbi' && (
                <span className={`text-xs ml-1 ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>RefSeq supports genome and annotation downloads here.</span>
            )}
        </div>
    )
}

function FileAvailabilityDropdown({ item, selectedTypes, localTypes = [], localFileInfo = null, itemTasks = [], onDownloadFiles, onCancelFiles, onDeleteFile, isLight }) {
    const popoverRef = useRef(null)
    const scrollBodyRef = useRef(null)
    const triggerRef = useRef(null)
    const dismissTimerRef = useRef(null)
    const [open, setOpen] = useState(false)
    const [popoverPlacement, setPopoverPlacement] = useState(null)
    const [loading, setLoading] = useState(false)
    const [availability, setAvailability] = useState(null)
    const [error, setError] = useState('')
    const [expandedReleaseKeys, setExpandedReleaseKeys] = useState(new Set())
    const [datasetSectionOpenByKey, setDatasetSectionOpenByKey] = useState({})
    const [selectedFileIds, setSelectedFileIds] = useState(new Set())
    const localTypeSet = useMemo(() => new Set((Array.isArray(localTypes) ? localTypes : []).map((type) => String(type || '').trim()).filter(Boolean)), [localTypes])

    const clearDismissTimer = useCallback(() => {
        if (dismissTimerRef.current) {
            window.clearTimeout(dismissTimerRef.current)
            dismissTimerRef.current = null
        }
    }, [])

    const scheduleDismiss = useCallback(() => {
        clearDismissTimer()
        dismissTimerRef.current = window.setTimeout(() => {
            dismissTimerRef.current = null
            setOpen(false)
        }, 1000)
    }, [clearDismissTimer])

    useEffect(() => () => clearDismissTimer(), [clearDismissTimer])

    useEffect(() => {
        if (!open) clearDismissTimer()
    }, [clearDismissTimer, open])

    const handlePopoverWheel = useCallback((event) => {
        const scrollEl = scrollBodyRef.current
        event.stopPropagation()
        event.preventDefault()
        if (!scrollEl) return

        const target = event.target
        const targetInScrollBody = target ? scrollEl.contains(target) : false
        if (!targetInScrollBody) return

        const deltaUnit = event.deltaMode === 1
            ? 16
            : event.deltaMode === 2
                ? scrollEl.clientHeight
                : 1
        const deltaY = event.deltaY * deltaUnit
        const deltaX = event.deltaX * deltaUnit

        if (deltaY) scrollEl.scrollTop += deltaY
        if (deltaX) scrollEl.scrollLeft += deltaX
    }, [])

    useEffect(() => {
        if (!open) return undefined
        const popoverEl = popoverRef.current
        if (!popoverEl) return undefined
        popoverEl.addEventListener('wheel', handlePopoverWheel, { capture: true, passive: false })
        return () => {
            popoverEl.removeEventListener('wheel', handlePopoverWheel, true)
        }
    }, [handlePopoverWheel, open])

    const allFiles = useMemo(() => {
        const assemblyFiles = Array.isArray(availability?.assembly_files) ? availability.assembly_files : []
        const releases = Array.isArray(availability?.dataset_releases) ? availability.dataset_releases : []
        return [
            ...assemblyFiles,
            ...releases.flatMap((release) => Array.isArray(release?.files) ? release.files : []),
        ]
    }, [availability])

    const isFileLocal = useCallback((file) => {
        if (!file) return false
        const localPath = localFilePathForAvailabilityFile(file, item, localFileInfo)
        if (localFileInfo) return Boolean(localPath)
        return localTypeSet.has(file?.type)
    }, [item, localFileInfo, localTypeSet])

    const resetSelectionFromToolbar = useCallback((nextAvailability, nextReleaseKey) => {
        const selected = chooseFilesForTypes({
            ...nextAvailability,
            default_dataset_release_key: nextReleaseKey || nextAvailability?.default_dataset_release_key,
        }, Array.from(selectedTypes))
            .filter((file) => {
                if (!file) return false
                const localPath = localFilePathForAvailabilityFile(file, item, localFileInfo)
                if (localFileInfo) return !localPath
                return !localTypeSet.has(file?.type)
            })
        setSelectedFileIds(new Set(selected.map(availabilityFileId)))
    }, [item, localFileInfo, localTypeSet, selectedTypes])

    const sortedFiles = useCallback((files) => {
        const familyOrder = {
            fasta: 0,
            metadata: 1,
            gff3: 10,
            gff3_index: 11,
            gtf: 12,
            gtf_index: 13,
            embl: 14,
            cdna: 20,
            cdna_index: 21,
            protein: 30,
            protein_index: 31,
            xref: 40,
            xref_index: 41,
            homology: 50,
            alignment: 70,
            other_annotation: 90,
        }
        return [...(Array.isArray(files) ? files : [])].sort((a, b) => {
            const oa = familyOrder[a?.type] ?? 80
            const ob = familyOrder[b?.type] ?? 80
            if (oa !== ob) return oa - ob
            return String(a?.filename || '').localeCompare(String(b?.filename || ''), undefined, { numeric: true, sensitivity: 'base' })
        })
    }, [])

    const updatePopoverPlacement = useCallback(() => {
        const trigger = triggerRef.current
        if (!trigger || typeof window === 'undefined') return
        const rect = trigger.getBoundingClientRect()
        const margin = 16
        const gap = 8
        const width = Math.min(680, Math.max(280, window.innerWidth - (margin * 2)))
        const left = Math.min(
            Math.max(margin, rect.right - width),
            Math.max(margin, window.innerWidth - width - margin),
        )
        const spaceBelow = window.innerHeight - rect.bottom - gap - margin
        const spaceAbove = rect.top - gap - margin
        const openAbove = spaceBelow < 300 && spaceAbove > spaceBelow
        const availableHeight = Math.max(220, openAbove ? spaceAbove : spaceBelow)
        const maxHeight = Math.min(540, availableHeight)
        const top = Math.max(margin, Math.min(window.innerHeight - margin - maxHeight, rect.bottom + gap))
        setPopoverPlacement({
            left,
            width,
            maxHeight,
            bodyMaxHeight: Math.max(160, maxHeight - 104),
            ...(openAbove
                ? { bottom: Math.max(margin, window.innerHeight - rect.top + gap) }
                : { top }),
        })
    }, [])

    useEffect(() => {
        if (!open) return undefined
        const handlePointerDown = (event) => {
            if (popoverRef.current?.contains(event.target) || triggerRef.current?.contains(event.target)) return
            setOpen(false)
        }
        const handleKeyDown = (event) => {
            if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', handlePointerDown)
        document.addEventListener('keydown', handleKeyDown)
        return () => {
            document.removeEventListener('mousedown', handlePointerDown)
            document.removeEventListener('keydown', handleKeyDown)
        }
    }, [open])

    useEffect(() => {
        if (!open) return undefined
        updatePopoverPlacement()
        const frameId = window.requestAnimationFrame(updatePopoverPlacement)
        window.addEventListener('resize', updatePopoverPlacement)
        window.addEventListener('scroll', updatePopoverPlacement, true)
        return () => {
            window.cancelAnimationFrame(frameId)
            window.removeEventListener('resize', updatePopoverPlacement)
            window.removeEventListener('scroll', updatePopoverPlacement, true)
        }
    }, [open, updatePopoverPlacement])

    useEffect(() => {
        if (!open || availability) return
        let cancelled = false
        const fetchAvailability = async () => {
            setLoading(true)
            setError('')
            try {
                const params = new URLSearchParams({
                    provider: normalizeGenomeProvider(item),
                    include_directory_listing: 'true',
                })
                const res = await fetch(`${API_BASE}/api/remote/files/${item.species_key}/${encodeURIComponent(getAssemblyAccession(item))}/availability?${params.toString()}`)
                const data = await res.json().catch(() => ({}))
                if (!res.ok) throw new Error(data?.detail || 'Could not load available files')
                if (cancelled) return
                const defaultReleaseKey = data?.default_dataset_release_key || data?.dataset_releases?.[0]?.key || ''
                setAvailability(data)
                setExpandedReleaseKeys(new Set(defaultReleaseKey ? [defaultReleaseKey] : []))
                setDatasetSectionOpenByKey({})
                resetSelectionFromToolbar(data, defaultReleaseKey)
            } catch (e) {
                if (!cancelled) setError(e?.message || 'Could not load available files')
            } finally {
                if (!cancelled) setLoading(false)
            }
        }
        fetchAvailability()
        return () => { cancelled = true }
    }, [availability, item, open, resetSelectionFromToolbar])

    const releases = useMemo(() => sortAvailabilityReleases(availability?.dataset_releases), [availability])
    const assemblyFiles = selectAssemblyDisplayFiles(sortedFiles(availability?.assembly_files))

    const toggleFile = (file) => {
        const id = availabilityFileId(file)
        setSelectedFileIds((prev) => {
            const next = new Set(prev)
            if (next.has(id)) {
                next.delete(id)
                return next
            }
            next.add(id)
            return next
        })
    }

    const toggleReleaseOpen = (releaseKey) => {
        setExpandedReleaseKeys((prev) => {
            const next = new Set(prev)
            next.has(releaseKey) ? next.delete(releaseKey) : next.add(releaseKey)
            return next
        })
    }

    const isDatasetSectionOpen = (releaseKey, section) => {
        const key = `${releaseKey}:${section}`
        if (Object.prototype.hasOwnProperty.call(datasetSectionOpenByKey, key)) {
            return !!datasetSectionOpenByKey[key]
        }
        return section === 'primary'
    }

    const toggleDatasetSectionOpen = (releaseKey, section) => {
        const key = `${releaseKey}:${section}`
        setDatasetSectionOpenByKey((prev) => ({
            ...prev,
            [key]: !isDatasetSectionOpen(releaseKey, section),
        }))
    }

    const toggleAllFiles = (files) => {
        setSelectedFileIds((prev) => {
            const next = new Set(prev)
            const ids = (Array.isArray(files) ? files : []).map(availabilityFileId)
            const allSelected = ids.length > 0 && ids.every((id) => next.has(id))
            ids.forEach((id) => {
                if (allSelected) next.delete(id)
            })
            if (!allSelected) {
                ids.forEach((id) => next.add(id))
            }
            return next
        })
    }

    const selectedFiles = allFiles.filter((file) => selectedFileIds.has(availabilityFileId(file)))
    const visibleSelectedFiles = selectedFiles.filter((file) => file?.type !== 'metadata')
    const selectedActiveFiles = visibleSelectedFiles.filter((file) => {
        const task = taskForAvailabilityFile(file, itemTasks, item)
        return ['pending', 'downloading'].includes(String(task?.status || ''))
    })
    const visibleDownloadFiles = visibleSelectedFiles.filter((file) => {
        const task = taskForAvailabilityFile(file, itemTasks, item)
        return !['pending', 'downloading'].includes(String(task?.status || ''))
    })
    const selectedHasLocalFiles = visibleDownloadFiles.some((file) => isFileLocal(file))
    const showCancelButton = visibleSelectedFiles.length > 0 && visibleDownloadFiles.length === 0 && selectedActiveFiles.length > 0

    const renderFileRow = (file, { label = compactFileLabel(file), primary = false } = {}) => {
        const localPath = localFilePathForAvailabilityFile(file, item, localFileInfo)
        const downloaded = isFileLocal(file)
        const task = taskForAvailabilityFile(file, itemTasks, item)
        const taskStatus = String(task?.status || '')
        const active = ['pending', 'downloading'].includes(taskStatus)
        const gridClass = file?.type === 'alignment'
            ? 'grid-cols-[18px_minmax(180px,0.9fr)_minmax(180px,1.1fr)_28px_28px]'
            : 'grid-cols-[18px_142px_minmax(160px,1fr)_28px_28px]'
        const statusIcon = taskStatus === 'downloading'
            ? (
                <span className={`inline-flex items-center justify-center ${isLight ? 'text-blue-700' : 'text-blue-300'}`} title={`Downloading ${Math.round((Number(task?.progress || 0)) * 100)}%`}>
                    <IconDownload size={13} progress={Number(task?.progress || 0)} />
                </span>
            )
            : taskStatus === 'pending'
                ? (
                    <span className={`inline-flex items-center justify-center ${isLight ? 'text-gray-400' : 'text-gray-500'}`} title="Queued">
                        <IconDownload size={14} />
                    </span>
                )
                : downloaded
                    ? (
                        <span className={`inline-flex items-center justify-center ${isLight ? 'text-green-600' : 'text-green-300'}`} title="Downloaded">
                            <IconDownloaded size={15} />
                        </span>
                    )
                    : null
        return (
        <div key={availabilityFileId(file)} className={`grid ${gridClass} items-center gap-2 px-2 py-1.5 rounded text-xs ${active ? (isLight ? 'bg-blue-50/60' : 'bg-blue-900/15') : (isLight ? 'hover:bg-gray-50' : 'hover:bg-gray-700/40')}`}>
            <input
                type="checkbox"
                checked={selectedFileIds.has(availabilityFileId(file))}
                onChange={() => toggleFile(file)}
                className="rounded"
            />
            <span className={`min-w-0 truncate font-semibold leading-5 ${primary ? (isLight ? 'text-gray-800' : 'text-gray-100') : (isLight ? 'text-gray-600' : 'text-gray-300')}`} title={label}>
                {label}
            </span>
            <span className={`min-w-0 truncate font-mono leading-5 ${isLight ? 'text-gray-500' : 'text-gray-400'}`} title={file.filename}>{file.filename}</span>
            <span className="min-h-[22px] flex items-center justify-center">
                {statusIcon}
            </span>
            <span className="min-h-[22px] flex items-center justify-center">
                {downloaded && localPath && (
                    <button
                        type="button"
                        title="Delete this downloaded file"
                        onClick={(event) => {
                            event.stopPropagation()
                            onDeleteFile?.(item, file, localPath)
                        }}
                        className={`w-6 h-6 inline-flex items-center justify-center rounded transition-colors ${isLight ? 'text-gray-400 hover:text-red-600 hover:bg-red-50' : 'text-gray-500 hover:text-red-400 hover:bg-red-900/20'}`}
                    >
                        <IconTrash size={12} />
                    </button>
                )}
            </span>
        </div>
        )
    }

    const renderDatasetSubsection = (releaseKey, section, label, files, renderFile) => {
        if (!Array.isArray(files) || files.length === 0) return null
        const openSection = isDatasetSectionOpen(releaseKey, section)
        const allSelected = files.length > 0 && files.every((file) => selectedFileIds.has(availabilityFileId(file)))
        return (
            <div>
                <div className="flex items-center justify-between gap-2 px-2 pb-0.5">
                    <button
                        type="button"
                        onClick={() => toggleDatasetSectionOpen(releaseKey, section)}
                        className={`min-w-0 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-left ${isLight ? 'text-gray-400 hover:text-gray-600' : 'text-gray-500 hover:text-gray-300'}`}
                    >
                        <IconUpDown open={openSection} size={11} />
                        <span>{label}</span>
                        <span className="font-medium tracking-normal normal-case">({files.length})</span>
                    </button>
                    <button
                        type="button"
                        onClick={() => toggleAllFiles(files)}
                        className={`text-xs font-semibold ${isLight ? 'text-blue-700 hover:text-blue-900' : 'text-blue-300 hover:text-blue-100'}`}
                    >
                        {allSelected ? 'Deselect all' : 'Select all'}
                    </button>
                </div>
                {openSection && (
                    <div className="grid grid-cols-1 gap-y-1">
                        {files.map(renderFile)}
                    </div>
                )}
            </div>
        )
    }

    const popover = open && typeof document !== 'undefined' ? createPortal(
        <div
            ref={popoverRef}
            className={`fixed z-[240] w-[680px] max-w-[calc(100vw-2rem)] rounded-lg border shadow-xl ${isLight ? 'bg-white border-gray-200 text-gray-900' : 'bg-gray-800 border-gray-700 text-gray-100'}`}
            style={{
                left: popoverPlacement?.left,
                top: popoverPlacement?.top,
                bottom: popoverPlacement?.bottom,
                width: popoverPlacement?.width,
                maxHeight: popoverPlacement?.maxHeight,
                visibility: popoverPlacement ? 'visible' : 'hidden',
            }}
            onClick={(e) => e.stopPropagation()}
            onMouseEnter={clearDismissTimer}
            onMouseLeave={scheduleDismiss}
        >
            <div className={`px-3 py-2 border-b ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
                <div className="text-xs font-bold uppercase tracking-widest">Available data</div>
                <div
                    className={`text-xs mt-0.5 truncate ${isLight ? 'text-gray-500' : 'text-gray-400'}`}
                    title={[item.scientific_name, item.common_name && `(${item.common_name})`, item.assembly_name, getAssemblyAccession(item)].filter(Boolean).join(' · ')}
                >
                    {[item.scientific_name, item.common_name && `(${item.common_name})`, item.assembly_name, getAssemblyAccession(item)].filter(Boolean).join(' · ')}
                </div>
            </div>
            {loading ? (
                <div className={`px-3 py-4 text-sm ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>Loading files…</div>
            ) : error ? (
                <div className="px-3 py-4 text-sm text-red-500">{error}</div>
            ) : (
                <div
                    ref={scrollBodyRef}
                    className="overflow-y-auto overscroll-contain p-3 space-y-3"
                    style={{ maxHeight: popoverPlacement?.bodyMaxHeight || 420 }}
                >
                    <div>
                        <div className="flex items-center justify-between gap-2 mb-1">
                            <div className={`text-[11px] font-bold uppercase tracking-widest ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>Assembly</div>
                        </div>
                        {assemblyFiles.length === 0 ? (
                            <div className={`text-xs ${isLight ? 'text-gray-400' : 'text-gray-500'}`}>No softmasked assembly listed</div>
                        ) : (
                            <div className="grid grid-cols-1 gap-y-1">
                                {assemblyFiles.map((file) => renderFileRow(file, { label: 'Assembly', primary: true }))}
                            </div>
                        )}
                    </div>
                    {releases.length === 0 ? (
                        <div className={`text-xs ${isLight ? 'text-gray-400' : 'text-gray-500'}`}>No dated dataset releases listed</div>
                    ) : releases.map((release) => {
                        const releaseFiles = sortedFiles(release?.files)
                        const primaryFiles = selectPrimaryDatasetFiles(releaseFiles)
                        const primaryIds = new Set(primaryFiles.map(availabilityFileId))
                        const alignmentFiles = sortFilesByCompactLabel(releaseFiles.filter((file) => file?.type === 'alignment'))
                        const otherFiles = sortFilesByCompactLabel(releaseFiles.filter((file) => (
                            !primaryIds.has(availabilityFileId(file)) && file?.type !== 'alignment'
                        )))
                        const releaseOpen = expandedReleaseKeys.has(release.key)
                        const directoryUrl = String(release?.directory_url || '').trim()
                        return (
                            <div key={release.key} className={`rounded-md border ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
                                <div className={`flex items-center justify-between gap-2 px-3 py-2 ${isLight ? 'bg-gray-50' : 'bg-gray-750'}`}>
                                    <div className="min-w-0">
                                        <button
                                            type="button"
                                            onClick={() => toggleReleaseOpen(release.key)}
                                            className="flex items-center gap-2 min-w-0 text-left"
                                        >
                                            <IconUpDown open={releaseOpen} size={12} />
                                            <span className={`text-[11px] font-bold uppercase tracking-widest ${isLight ? 'text-gray-600' : 'text-gray-300'}`}>
                                                {release.label || release.key}
                                            </span>
                                            {release.is_default && (
                                                <span className={`text-[10px] px-1.5 py-0.5 rounded ${isLight ? 'bg-blue-100 text-blue-700' : 'bg-blue-900/40 text-blue-200'}`}>Latest</span>
                                            )}
                                        </button>
                                        {directoryUrl && (
                                            <a
                                                href={directoryUrl}
                                                target="_blank"
                                                rel="noreferrer"
                                                onClick={(e) => e.stopPropagation()}
                                                className={`block pl-5 mt-0.5 truncate text-[11px] font-mono ${isLight ? 'text-blue-700 hover:text-blue-900' : 'text-blue-300 hover:text-blue-100'}`}
                                                title={directoryUrl}
                                            >
                                            {directoryUrl}
                                            </a>
                                        )}
                                    </div>
                                </div>
                                {releaseOpen && (
                                    <div className="p-2">
                                        {releaseFiles.length === 0 ? (
                                            <div className={`text-xs ${isLight ? 'text-gray-400' : 'text-gray-500'}`}>No dataset files listed</div>
                                        ) : (
                                            <div className="space-y-2">
                                                {renderDatasetSubsection(
                                                    release.key,
                                                    'primary',
                                                    'Primary',
                                                    primaryFiles,
                                                    (file) => renderFileRow(file, { label: compactFileLabel(file, true), primary: true }),
                                                )}
                                                {renderDatasetSubsection(
                                                    release.key,
                                                    'alignments',
                                                    'Alignments',
                                                    alignmentFiles,
                                                    (file) => renderFileRow(file, { label: alignmentFileLabel(file) }),
                                                )}
                                                {renderDatasetSubsection(
                                                    release.key,
                                                    'other',
                                                    'Other',
                                                    otherFiles,
                                                    (file) => renderFileRow(file, { label: compactFileLabel(file) }),
                                                )}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        )
                    })}
                </div>
            )}
            <div className={`px-3 py-2 border-t flex items-center justify-between gap-2 ${isLight ? 'border-gray-200 bg-gray-50' : 'border-gray-700 bg-gray-750'}`}>
                <span className={`text-xs ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>{visibleSelectedFiles.length} selected</span>
                <button
                    type="button"
                    disabled={visibleSelectedFiles.length === 0}
                    onClick={() => {
                        if (showCancelButton) {
                            onCancelFiles?.(withRequiredMetadataFiles(visibleSelectedFiles, allFiles))
                            return
                        }
                        onDownloadFiles(withRequiredMetadataFiles(visibleDownloadFiles, allFiles), { force: selectedHasLocalFiles })
                        setOpen(false)
                    }}
                    className={`px-3 py-1.5 rounded-md text-xs font-semibold text-white ${visibleSelectedFiles.length === 0
                        ? 'bg-gray-400 cursor-not-allowed'
                        : showCancelButton
                            ? 'bg-red-600 hover:bg-red-500'
                            : 'bg-blue-600 hover:bg-blue-500'}`}
                >
                    {showCancelButton ? 'Cancel' : 'Download'}
                </button>
            </div>
        </div>,
        document.body,
    ) : null

    return (
        <div className="relative">
            <button
                ref={triggerRef}
                type="button"
                title="Choose exact files"
                onClick={(e) => {
                    e.stopPropagation()
                    clearDismissTimer()
                    setOpen((prev) => {
                        const next = !prev
                        if (next) setPopoverPlacement(null)
                        return next
                    })
                }}
                className={`w-8 h-8 inline-flex items-center justify-center rounded-md border transition-colors ${isLight
                    ? 'text-gray-500 border-gray-200 hover:text-gray-800 hover:bg-gray-50'
                    : 'text-gray-400 border-gray-700 hover:text-gray-100 hover:bg-gray-700'}`}
            >
                <IconFiles size={15} />
            </button>
            {popover}
        </div>
    )
}

function GenomeRowActions({
    item,
    selectedTypes,
    localTypes = [],
    localFileInfo = null,
    tasksByItemKey,
    downloading,
    demoProgress = null,
    isLight,
    onDownload,
    onDownloadFiles,
    onCancelFiles,
    onDeleteFile,
    onDelete = null,
    deleteDisabled = false,
    deleteTitle = 'Remove downloaded files',
}) {
    const itemTasks = tasksByItemKey?.[item.id] || []
    // The demo genome is copied from disk rather than queued, so it has no tasks to read
    // progress from and none of the machinery below sees it as running. Its progress is
    // driven from above instead, and the button is otherwise treated exactly the same.
    const isDemo = isDemoGenomeItem(item)
    const demoRunning = isDemo && demoProgress != null
    const desiredTypes = selectedDownloadTypeList(selectedTypes)
    const desiredTypesWithMetadata = withImplicitMetadataTypes(desiredTypes)
    const activeTypeSet = new Set(itemTasks
        .filter((task) => ['pending', 'downloading'].includes(String(task.status || '')))
        .map((task) => String(task.file_type || ''))
        .filter(Boolean))
    const pendingTypes = missingSelectedDownloadTypes(selectedTypes, localTypes)
    const downloadTypes = pendingTypes.filter((type) => !activeTypeSet.has(type))
    const complete = desiredTypes.length > 0 && pendingTypes.length === 0
    const activeTasks = itemTasks.filter((task) => (
        ['pending', 'downloading'].includes(String(task.status || ''))
        && desiredTypesWithMetadata.includes(String(task.file_type || ''))
    ))
    const active = demoRunning || (desiredTypes.length > 0 && activeTasks.length > 0 && downloadTypes.length === 0)
    const activeProgress = demoRunning
        ? demoProgress
        : itemTasks
            .filter((task) => activeTasks.includes(task))
            .reduce((best, task) => Math.max(best, Number(task.progress || 0)), 0)
    // A tutorial step the user cannot repeat is a step they cannot go back to, so the demo
    // genome stays downloadable after it has been downloaded. Re-fetching it just
    // overwrites the same handful of files.
    const replayable = isDemo && !demoRunning
    const disabled = replayable
        ? false
        : (downloading || desiredTypes.length === 0 || active || downloadTypes.length === 0)
    const title = desiredTypes.length === 0
        ? 'Select data to download'
        : active
            ? `Downloading ${Math.round(activeProgress * 100)}%`
        : complete
            ? 'Selected data is already downloaded'
            : downloadTypes.length > 0
                ? 'Download selected data'
                : 'Selected data is already queued'

    const buttonClass = active
        ? (isLight ? 'text-blue-700 border-blue-200 cursor-progress' : 'text-blue-300 border-blue-900/50 cursor-progress')
        : complete
            // The green tick means "already here", which is normally the end of it — except
            // for the demo genome, which stays re-fetchable so the tutorial step can be
            // replayed, and so must still look like something you can press.
            ? `${isLight ? 'text-green-600 bg-green-50 border-green-100' : 'text-green-300 bg-green-900/20 border-green-900/40'} ${replayable ? 'cursor-pointer' : 'cursor-default'}`
            : disabled
                ? 'opacity-40 border-transparent cursor-not-allowed'
                // cursor-pointer is not the browser default on a button, and a control the
                // tutorial is asking someone to click should look like one.
                : (isLight ? 'cursor-pointer text-blue-700 border-blue-100 hover:bg-blue-50' : 'cursor-pointer text-blue-300 border-blue-900/40 hover:bg-blue-900/20')
    const Icon = complete && !active ? IconDownloaded : IconDownload
    const downloadNow = replayable && downloadTypes.length === 0 ? desiredTypes : downloadTypes

    return (
        <div className="flex items-center justify-end gap-1">
            <FileAvailabilityDropdown
                item={item}
                selectedTypes={selectedTypes}
                localTypes={localTypes}
                localFileInfo={localFileInfo}
                itemTasks={itemTasks}
                onDownloadFiles={(files, options) => onDownloadFiles(item, files, options)}
                onCancelFiles={(files) => onCancelFiles?.(item, files)}
                onDeleteFile={onDeleteFile}
                isLight={isLight}
            />
            <button
                data-tour-id={`download-start-${item.species_key}`}
                type="button"
                disabled={disabled}
                title={title}
                onClick={(e) => {
                    e.stopPropagation()
                    if (downloadNow.length === 0) return
                    onDownload(item, { selectedTypes: downloadNow })
                }}
                className={`w-8 h-8 inline-flex items-center justify-center rounded-md border transition-colors ${buttonClass}`}
            >
                <Icon size={15} progress={active ? activeProgress : null} />
            </button>
            {onDelete && (
                <button
                    type="button"
                    disabled={deleteDisabled}
                    title={deleteTitle}
                    onClick={(e) => {
                        e.stopPropagation()
                        if (!deleteDisabled) onDelete(item)
                    }}
                    className={`w-8 h-8 inline-flex items-center justify-center rounded-md transition-colors ${deleteDisabled
                        ? 'opacity-35 cursor-not-allowed'
                        : (isLight ? 'text-gray-400 hover:text-red-600 hover:bg-red-50' : 'text-gray-500 hover:text-red-400 hover:bg-red-900/20')}`}
                >
                    <IconTrash size={14} />
                </button>
            )}
        </div>
    )
}

// ---------------------------------------------------------------------------
// Species table row
// ---------------------------------------------------------------------------
function SpeciesRow({ species, expanded, onToggleExpand, onDownload, onDownloadAll, onDownloadFiles, onCancelFiles, onDeleteFile, selectedTypes, localTypeByKey, localFileInfoByKey = new Map(), tasksByItemKey, downloading, demoProgress = null, isLight }) {
    const hasMany = species.assemblies.length > 1
    const firstAsm = species.assemblies[0]

    const gridCols = 'minmax(0, 2fr) 155px minmax(0, 1fr) 140px 92px'
    const rowBase = `grid items-center border-b text-sm transition-colors ${isLight ? 'border-gray-100 hover:bg-gray-50' : 'border-gray-700/50 hover:bg-gray-700/30'}`

    const renderActions = (asm) => {
        const item = itemFromSpeciesAssembly(species, asm)
        const localTypes = localTypeByKey.get(item.id) || []
        const localFileInfo = localFileInfoByKey.get(item.id) || null
        return (
            <GenomeRowActions
                item={item}
                selectedTypes={selectedTypes}
                localTypes={localTypes}
                localFileInfo={localFileInfo}
                tasksByItemKey={tasksByItemKey}
                downloading={downloading}
                demoProgress={demoProgress}
                isLight={isLight}
                onDownload={onDownload}
                onDownloadFiles={onDownloadFiles}
                onCancelFiles={onCancelFiles}
                onDeleteFile={onDeleteFile}
            />
        )
    }

    // Single assembly — standard row with direct download actions
    if (!hasMany) {
        return (
            <div data-tour-id={`download-species-${species.key}`} className={rowBase} style={{ gridTemplateColumns: gridCols }}>
                <div className={`px-3 py-2.5 overflow-hidden ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>
                    <div className="font-medium leading-tight truncate" title={species.scientific_name}>{species.scientific_name}</div>
                    {species.common_name && (
                        <div className={`text-xs mt-0.5 truncate ${isLight ? 'text-gray-500' : 'text-gray-400'}`} title={species.common_name}>{species.common_name}</div>
                    )}
                </div>
                <div className={`px-3 py-2.5 font-mono text-xs truncate ${isLight ? 'text-gray-600' : 'text-gray-400'}`} title={getAssemblyAccession(firstAsm)}>
                    {getAssemblyAccession(firstAsm)}
                </div>
                <div className={`px-3 py-2.5 text-xs truncate ${isLight ? 'text-gray-700' : 'text-gray-300'}`} title={firstAsm?.name}>
                    {firstAsm?.name}
                </div>
                <div className={`px-3 py-2.5 text-xs truncate ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                    {firstAsm?.source_database || firstAsm?.level}
                </div>
                <div className="px-3 py-2.5">
                    {renderActions(firstAsm)}
                </div>
            </div>
        )
    }

    // Multi-assembly — collapsible header row + individual assembly rows
    const selectedTypesByItem = {}
    let pendingAssemblyCount = 0
    for (const asm of species.assemblies) {
        const item = itemFromSpeciesAssembly(species, asm)
        const localTypes = localTypeByKey.get(item.id) || []
        const itemTasks = tasksByItemKey?.[item.id] || []
        const activeTypeSet = new Set(itemTasks
            .filter((task) => ['pending', 'downloading'].includes(String(task.status || '')))
            .map((task) => String(task.file_type || ''))
            .filter(Boolean))
        const pendingTypes = missingSelectedDownloadTypes(selectedTypes, localTypes).filter((type) => !activeTypeSet.has(type))
        selectedTypesByItem[item.id] = pendingTypes
        if (pendingTypes.length > 0) pendingAssemblyCount++
    }
    const selectedTypeCount = selectedDownloadTypeList(selectedTypes).length
    const allSelectedDataDownloaded = selectedTypeCount > 0 && pendingAssemblyCount === 0

    return (
        <div>
            {/* Header row — click anywhere to expand/collapse; flex layout so name spans full width */}
            <div
                className={`flex items-center border-b text-sm transition-colors cursor-pointer ${isLight ? 'border-gray-100 hover:bg-gray-50' : 'border-gray-700/50 hover:bg-gray-700/30'}`}
                onClick={() => onToggleExpand(species.key)}
            >
                <div className="flex-1 min-w-0 px-3 py-2.5">
                    <div className={`font-medium leading-tight ${isLight ? 'text-blue-700' : 'text-blue-400'}`}>
                        {species.scientific_name}
                        <span className={`ml-2 text-xs font-normal ${isLight ? 'text-gray-400' : 'text-gray-500'}`}>
                            ({species.assemblies.length} assemblies)
                        </span>
                    </div>
                    {species.common_name && (
                        <div className={`text-xs mt-0.5 ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>{species.common_name}</div>
                    )}
                </div>
                <div className="px-3 py-2.5 shrink-0 flex items-center gap-1">
                    <button
                        type="button"
                        title={expanded ? 'Collapse assemblies' : 'Expand assemblies'}
                        aria-label={expanded ? 'Collapse assemblies' : 'Expand assemblies'}
                        onClick={(e) => {
                            e.stopPropagation()
                            onToggleExpand(species.key)
                        }}
                        className={`w-8 h-8 inline-flex items-center justify-center rounded-md border transition-colors ${isLight
                            ? 'text-gray-500 border-gray-200 hover:text-gray-800 hover:bg-gray-50'
                            : 'text-gray-400 border-gray-700 hover:text-gray-100 hover:bg-gray-700'}`}
                    >
                        <IconUpDown open={expanded} size={14} />
                    </button>
                    <button
                        type="button"
                        disabled={downloading || selectedTypeCount === 0 || pendingAssemblyCount === 0}
                        title={allSelectedDataDownloaded ? 'Selected data is already downloaded for all assemblies' : 'Download selected files for all assemblies sequentially'}
                        onClick={(e) => {
                            e.stopPropagation()
                            onDownloadAll(species, { selectedTypesByItem })
                        }}
                        // Asymmetric padding on purpose. The icon-only download button in
                        // single-assembly rows insets its icon by centring it in a w-8 box,
                        // which works out at 7.5px from the edge; matching that here puts
                        // both icons' centres on the same vertical axis.
                        className={`${allSelectedDataDownloaded ? 'w-8 h-8 justify-center' : 'gap-1.5 pl-2.5 pr-[7.5px] py-1.5'} inline-flex items-center rounded-md text-xs font-semibold transition-colors ${downloading || selectedTypeCount === 0 || pendingAssemblyCount === 0
                            ? (allSelectedDataDownloaded
                                ? (isLight ? 'text-green-700 bg-green-50 border border-green-100 cursor-default' : 'text-green-300 bg-green-900/20 border border-green-900/40 cursor-default')
                                : 'opacity-40 cursor-not-allowed border border-transparent')
                            : (isLight ? 'text-blue-700 bg-white border border-blue-100 hover:bg-blue-50' : 'text-blue-300 bg-gray-800 border border-blue-900/40 hover:bg-blue-900/20')}`}
                    >
                        {!allSelectedDataDownloaded && <span>Download all</span>}
                        {allSelectedDataDownloaded ? <IconDownloaded size={15} /> : <IconDownload size={15} />}
                    </button>
                </div>
            </div>

            {/* Expanded assembly rows — same grid layout as single-assembly rows, but with a visual spine in the first column */}
            {expanded && (
                <div className="relative">
                    {/* The Clickable Spine Area: entire left margin area acts as collapse target */}
                    <div
                        className="absolute top-0 bottom-0 left-0 w-8 cursor-pointer z-10"
                        title="Collapse"
                        onClick={() => onToggleExpand(species.key)}
                    />

                    {species.assemblies.map((asm, index) => {
                        const isLast = index === species.assemblies.length - 1

                        return (
                            <div
                                key={getAssemblyAccession(asm)}
                                className={`relative grid items-center text-sm transition-colors ${isLast ? 'border-b' : ''
                                    } ${isLight ? 'border-gray-100' : 'border-gray-700/50 hover:bg-gray-700/10'}`}
                                style={{ gridTemplateColumns: gridCols }}
                            >
                                {/* Column 1: Species name with visual spine offset */}
                                <div className={`px-3 py-2.5 overflow-hidden flex items-stretch ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>
                                    {/* Visual tree connecting lines */}
                                    <div className="relative w-8 shrink-0 mr-2 flex items-center cursor-pointer pointer-events-auto" onClick={() => onToggleExpand(species.key)}>
                                        {/* Vertical line: goes all the way down unless it's the last item (then only goes halfway) */}
                                        <div
                                            className={`absolute left-4 top-0 ${isLast ? 'bottom-1/2' : 'bottom-0'} border-l-2 ${isLight ? 'border-gray-300' : 'border-gray-600'}`}
                                        />
                                        {/* Horizontal connecting line: from the vertical line to the text */}
                                        <div
                                            className={`absolute left-4 w-4 border-b-2 ${isLight ? 'border-gray-300' : 'border-gray-600'}`}
                                        />
                                    </div>

                                    <div className="flex-1 min-w-0 flex flex-col justify-center">
                                        <div className="font-medium leading-tight truncate" title={species.scientific_name}>{species.scientific_name}</div>
                                        {species.common_name && (
                                            <div className={`text-xs mt-0.5 truncate ${isLight ? 'text-gray-500' : 'text-gray-400'}`} title={species.common_name}>{species.common_name}</div>
                                        )}
                                    </div>
                                </div>

                                {/* Remaining columns match grid alignment perfectly */}
                                <div className={`px-3 py-2.5 font-mono text-xs truncate ${isLight ? 'text-gray-600' : 'text-gray-400'}`} title={getAssemblyAccession(asm)}>
                                    {getAssemblyAccession(asm)}
                                </div>
                                <div className={`px-3 py-2.5 text-xs truncate ${isLight ? 'text-gray-700' : 'text-gray-300'}`} title={asm.name}>
                                    {asm.name}
                                </div>
                                <div className={`px-3 py-2.5 text-xs truncate ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                    {asm.source_database || asm.level}
                                </div>
                                <div className="px-3 py-2.5">
                                    {renderActions(asm)}
                                </div>
                            </div>
                        )
                    })}
                </div>
            )}
        </div>
    )
}

// ---------------------------------------------------------------------------
// Collapsible panel header (shared between both panels)
// ---------------------------------------------------------------------------
function PanelHeader({ title, count, countLabel, collapsed, onToggle, isLight, actions }) {
    const canToggle = typeof onToggle === 'function'
    return (
        <div
            className={`px-4 py-2.5 flex items-center justify-between select-none shrink-0 ${canToggle ? 'cursor-pointer' : ''} ${isLight ? (canToggle ? 'bg-gray-50 hover:bg-gray-100' : 'bg-gray-50') : (canToggle ? 'bg-gray-750 hover:bg-gray-700' : 'bg-gray-750')}`}
            onClick={onToggle}
        >
            <div className="flex items-center gap-2.5">
                <span className={`text-xs font-bold uppercase tracking-widest ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                    {title}
                </span>
                {count !== undefined && (
                    <span className={`text-xs tabular-nums px-2 py-0.5 rounded-full font-medium ${isLight ? 'bg-gray-200 text-gray-600' : 'bg-gray-700 text-gray-300'}`}>
                        {countLabel ?? count}
                    </span>
                )}
            </div>
            <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
                {actions}
                {canToggle && (
                    <span className={isLight ? 'text-gray-400' : 'text-gray-500'} onClick={onToggle}>
                        <IconUpDown open={!collapsed} size={14} />
                    </span>
                )}
            </div>
        </div>
    )
}

// ---------------------------------------------------------------------------
// My Download List
// ---------------------------------------------------------------------------
const FILE_TYPES = [
    { id: 'fasta', label: 'FASTA' },
    { id: 'gff3', label: 'Genes' },
    { id: 'homology', label: 'Homologies' },
]

function MyDownloadList({ items, onRemove, onClear, onDownload, onRetry, downloading, statusMsg,
    collapsed, onToggleCollapse, tasksByItemKey, isLight }) {

    const [selected, setSelected] = useState(new Set())
    const [activeTypes, setActiveTypes] = useState(() => new Set(DEFAULT_DOWNLOAD_FILE_TYPES))
    const [typeError, setTypeError] = useState(false)
    const [dlPage, setDlPage] = useState(1)

    const dlTotalPages = Math.ceil(items.length / DL_PAGE_SIZE)
    const pageItems = items.slice((dlPage - 1) * DL_PAGE_SIZE, dlPage * DL_PAGE_SIZE)

    // Reset page if items shrink
    useEffect(() => {
        if (dlPage > dlTotalPages && dlTotalPages > 0) setDlPage(dlTotalPages)
    }, [dlPage, dlTotalPages])

    // Keep selection set in sync if rows are removed while downloading.
    useEffect(() => {
        const itemIds = new Set(items.map((i) => i.id))
        setSelected((prev) => {
            const next = new Set([...prev].filter((id) => itemIds.has(id)))
            return next.size === prev.size ? prev : next
        })
    }, [items])

    const toggleItem = (id) => {
        setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
    }
    const toggleAll = () => {
        setSelected(selected.size === items.length && items.length > 0 ? new Set() : new Set(items.map(i => i.id)))
    }
    const toggleType = (t) => {
        setActiveTypes(prev => { const n = new Set(prev); n.has(t) ? n.delete(t) : n.add(t); return n })
        setTypeError(false)
    }

    const handleDownloadClick = () => {
        if (activeTypes.size === 0) {
            setTypeError(true)
            setTimeout(() => setTypeError(false), 2500)
            return
        }
        onDownload(items.filter(i => selected.has(i.id)), [...activeTypes])
    }

    const panelBase = `shrink-0 rounded-xl border overflow-hidden ${isLight ? 'bg-white border-gray-200' : 'bg-gray-800 border-gray-700'}`
    const borderClass = isLight ? 'border-gray-200' : 'border-gray-700'

    const clearBtn = items.length > 0 && (
        <button
            onClick={(e) => { e.stopPropagation(); onClear() }}
            className={`flex items-center gap-1 text-xs px-2 py-1 rounded transition-colors ${isLight ? 'text-red-600 hover:bg-red-50' : 'text-red-400 hover:bg-red-900/20'}`}
        >
            <IconTrash size={12} /> Clear all
        </button>
    )

    return (
        <div className={panelBase}>
            <PanelHeader
                title="My Download List"
                count={items.length}
                collapsed={collapsed}
                onToggle={onToggleCollapse}
                isLight={isLight}
                actions={clearBtn}
            />

            {!collapsed && (
                items.length === 0 ? (
                    <div className={`px-4 py-5 text-center text-sm border-t ${borderClass} ${isLight ? 'text-gray-400' : 'text-gray-500'}`}>
                        Downloaded genomes and data are selectable in the Genome Selector
                    </div>
                ) : (
                    <>
                        {/* Table — grows organically, no internal scroll */}
                        <div className={`border-t ${borderClass}`}>
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className={`border-b text-xs ${isLight ? 'bg-gray-50 border-gray-200 text-gray-500' : 'bg-gray-800 border-gray-700 text-gray-400'}`}>
                                        <th className="px-3 py-2 text-left w-8">
                                            <input type="checkbox"
                                                checked={selected.size === items.length && items.length > 0}
                                                onChange={toggleAll} className="rounded" />
                                        </th>
                                        <th className="px-3 py-2 text-left font-medium">Species</th>
                                        <th className="px-3 py-2 text-left font-medium">Accession</th>
                                        <th className="px-3 py-2 text-left font-medium">Assembly</th>
                                        <th className="px-3 py-2 text-left font-medium">Files available</th>
                                        <th className="px-3 py-2 w-8"></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {pageItems.map(item => {
                                        const itemTasks = tasksByItemKey?.[item.id] || []
                                        return (
                                            <tr key={item.id}
                                                className={`border-b transition-colors ${isLight ? 'border-gray-100 hover:bg-gray-50' : 'border-gray-700/50 hover:bg-gray-700/20'} ${selected.has(item.id) ? (isLight ? 'bg-blue-50/50' : 'bg-blue-900/10') : ''}`}>
                                                <td className="px-3 py-2">
                                                    <input type="checkbox" checked={selected.has(item.id)}
                                                        onChange={() => toggleItem(item.id)} className="rounded" />
                                                </td>
                                                <td className={`px-3 py-2 ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>
                                                    <div className="font-medium leading-tight">{item.scientific_name}</div>
                                                    {item.common_name && (
                                                        <div className={`text-xs ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>{item.common_name}</div>
                                                    )}
                                                </td>
                                                <td className={`px-3 py-2 font-mono text-xs ${isLight ? 'text-gray-600' : 'text-gray-400'}`}>
                                                    <div>{getAssemblyAccession(item)}</div>
                                                    <div className={`${isLight ? 'text-gray-400' : 'text-gray-500'}`}>{item.source_database || normalizeGenomeSourceDatabase(item)}</div>
                                                </td>
                                                <td className={`px-3 py-2 text-xs ${isLight ? 'text-gray-700' : 'text-gray-300'}`}>{item.assembly_name}</td>
                                                <td className="px-3 py-2">
                                                    <div className="flex gap-1 flex-wrap">
                                                        {item.availableTypes === null && (
                                                            <span className={`text-xs ${isLight ? 'text-gray-400' : 'text-gray-500'}`}>loading…</span>
                                                        )}
                                                        {item.availableTypes?.length === 0 && itemTasks.length === 0 && (
                                                            <span className={`text-xs ${isLight ? 'text-gray-400' : 'text-gray-500'}`}>—</span>
                                                        )}
                                                        {/* Show badges for known available types, with local download status */}
                                                        {item.availableTypes?.map(t => (
                                                            <FileStatusBadge key={t} type={t} itemTasks={itemTasks} isLocal={item.localTypes?.includes(t)} onRetry={onRetry ? (type) => onRetry(item, type) : undefined} />
                                                        ))}
                                                        {/* Also surface any task types not already shown (e.g. if files endpoint unavailable) */}
                                                        {itemTasks
                                                            .filter(t => t.file_type && !item.availableTypes?.includes(t.file_type))
                                                            .filter((t, i, arr) => arr.findIndex(x => x.file_type === t.file_type) === i)
                                                            .map(t => (
                                                                <FileStatusBadge key={t.file_type} type={t.file_type} itemTasks={itemTasks} isLocal={item.localTypes?.includes(t.file_type)} onRetry={onRetry ? (type) => onRetry(item, type) : undefined} />
                                                            ))
                                                        }
                                                    </div>
                                                </td>
                                                <td className="px-3 py-2">
                                                    <button onClick={() => onRemove(item.id)}
                                                        className={`p-1 rounded transition-colors ${isLight ? 'text-gray-400 hover:text-red-600 hover:bg-red-50' : 'text-gray-500 hover:text-red-400 hover:bg-red-900/20'}`}>
                                                        <IconTrash size={13} />
                                                    </button>
                                                </td>
                                            </tr>
                                        )
                                    })}
                                </tbody>
                            </table>
                        </div>

                        {/* Download list pagination */}
                        {dlTotalPages > 1 && (
                            <div className={`px-4 py-2 border-t flex items-center justify-between ${isLight ? 'bg-gray-50 border-gray-200' : 'bg-gray-750 border-gray-700'}`}>
                                <button
                                    onClick={() => setDlPage(p => Math.max(1, p - 1))}
                                    disabled={dlPage === 1}
                                    className={`px-3 py-1 text-xs rounded border transition-colors ${dlPage === 1
                                        ? (isLight ? 'text-gray-300 border-gray-200' : 'text-gray-600 border-gray-700')
                                        : (isLight ? 'text-gray-700 border-gray-300 hover:bg-gray-100' : 'text-gray-300 border-gray-600 hover:bg-gray-700')}`}
                                >
                                    ← Previous
                                </button>
                                <span className={`text-xs ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                    Page {dlPage} of {dlTotalPages}
                                    <span className="ml-2 opacity-60">
                                        ({((dlPage - 1) * DL_PAGE_SIZE) + 1}–{Math.min(dlPage * DL_PAGE_SIZE, items.length)} of {items.length})
                                    </span>
                                </span>
                                <button
                                    onClick={() => setDlPage(p => Math.min(dlTotalPages, p + 1))}
                                    disabled={dlPage === dlTotalPages}
                                    className={`px-3 py-1 text-xs rounded border transition-colors ${dlPage === dlTotalPages
                                        ? (isLight ? 'text-gray-300 border-gray-200' : 'text-gray-600 border-gray-700')
                                        : (isLight ? 'text-gray-700 border-gray-300 hover:bg-gray-100' : 'text-gray-300 border-gray-600 hover:bg-gray-700')}`}
                                >
                                    Next →
                                </button>
                            </div>
                        )}

                        {/* Footer: file type toggles + download */}
                        <div className={`px-4 py-3 border-t flex items-center gap-4 flex-wrap ${isLight ? 'bg-gray-50 border-gray-200' : 'bg-gray-750 border-gray-700'}`}>
                            <div className="flex items-center gap-2">
                                <span className={`text-xs font-medium ${isLight ? 'text-gray-600' : 'text-gray-400'}`}>File types:</span>
                                <div className={`flex gap-1 rounded-md p-0.5 transition-all ${typeError ? 'ring-2 ring-red-500 ring-offset-1' : ''}`}>
                                    {FILE_TYPES.map(ft => (
                                        <button key={ft.id} onClick={() => toggleType(ft.id)}
                                            className={`px-2.5 py-1 rounded text-xs font-medium transition-colors border ${activeTypes.has(ft.id)
                                                ? 'bg-blue-600 text-white border-blue-600'
                                                : (isLight ? 'bg-white text-gray-600 border-gray-200 hover:border-blue-300' : 'bg-gray-800 text-gray-400 border-gray-600 hover:border-blue-500')
                                                }`}>
                                            {ft.label}
                                        </button>
                                    ))}
                                </div>
                                {typeError && (
                                    <span className="text-xs text-red-500 animate-pulse">Select at least one file type</span>
                                )}
                            </div>

                            <div className="flex items-center gap-3 ml-auto">
                                {statusMsg && (
                                    <span className={`text-xs ${statusMsg.isError ? 'text-red-500' : (statusMsg.isWarning ? 'text-amber-500' : 'text-green-600')}`}>{statusMsg.text}</span>
                                )}
                                <span className={`text-xs ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>{selected.size} selected</span>
                                <button
                                    onClick={handleDownloadClick}
                                    disabled={selected.size === 0 || downloading}
                                    className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-white transition-all ${selected.size === 0 || downloading
                                        ? 'bg-gray-400 cursor-not-allowed'
                                        : 'bg-blue-600 hover:bg-blue-500 shadow-sm shadow-blue-500/20'}`}
                                >
                                    <IconDownload size={15} />
                                    {downloading ? 'Starting…' : 'Download Selected'}
                                </button>
                            </div>
                        </div>
                    </>
                )
            )}
        </div>
    )
}

// ---------------------------------------------------------------------------
// Local Genomes List
// ---------------------------------------------------------------------------
function LocalGenomesList({
    items,
    activeItems = [],
    selectedTypes,
    tasksByItemKey,
    isLight,
    onDownload,
    onDownloadFiles,
    onCancelFiles,
    onDeleteFile,
    onDeleteLocalGenome,
    onDeleteAllLocalGenomes,
    deletingLocalGenomes = false,
    downloading = false,
}) {
    const panelRef = useRef(null)
    const [pendingDeleteKey, setPendingDeleteKey] = useState('')
    const [pendingDeleteAll, setPendingDeleteAll] = useState(false)
    const panelBase = `rounded-xl border overflow-hidden ${isLight ? 'bg-white border-gray-200' : 'bg-gray-800 border-gray-700'}`
    const borderClass = isLight ? 'border-gray-200' : 'border-gray-700'
    const gridCols = 'minmax(0, 2fr) 155px minmax(0, 1fr) 140px 124px'
    const rowBase = `grid items-center border-b text-sm transition-colors ${isLight ? 'border-gray-100 hover:bg-gray-50' : 'border-gray-700/50 hover:bg-gray-700/30'}`
    const thClass = `px-3 py-2 text-left text-xs font-medium ${isLight ? 'text-gray-500' : 'text-gray-400'}`
    const activeSortedItems = useMemo(() => [...activeItems].sort((a, b) => {
        const nameCompare = String(a.scientific_name || '').localeCompare(String(b.scientific_name || ''), undefined, { sensitivity: 'base' })
        if (nameCompare !== 0) return nameCompare
        return String(getAssemblyAccession(a)).localeCompare(String(getAssemblyAccession(b)), undefined, { numeric: true, sensitivity: 'base' })
    }), [activeItems])
    const sortedItems = useMemo(() => [...items].sort((a, b) => {
        const nameCompare = String(a.scientific_name || '').localeCompare(String(b.scientific_name || ''), undefined, { sensitivity: 'base' })
        if (nameCompare !== 0) return nameCompare
        return String(getAssemblyAccession(a)).localeCompare(String(getAssemblyAccession(b)), undefined, { numeric: true, sensitivity: 'base' })
    }), [items])
    const activeTaskCount = activeSortedItems.reduce((sum, item) => {
        const key = getAssemblyGenomeKey(item)
        const tasks = tasksByItemKey?.[key] || []
        return sum + tasks.filter((task) => ['pending', 'downloading'].includes(task.status)).length
    }, 0)
    const failedTaskCount = activeSortedItems.reduce((sum, item) => {
        const key = getAssemblyGenomeKey(item)
        const tasks = tasksByItemKey?.[key] || []
        return sum + tasks.filter((task) => task.status === 'failed').length
    }, 0)
    const localKeys = new Set(sortedItems.map((item) => getAssemblyGenomeKey(item)))
    const visibleActiveItems = activeSortedItems.filter((item) => !localKeys.has(getAssemblyGenomeKey(item)))
    const deletableItems = sortedItems.filter((item) => item?.download_managed)
    const countLabel = [
        `${items.length} local`,
        activeTaskCount > 0 ? `${activeTaskCount} active` : '',
        failedTaskCount > 0 ? `${failedTaskCount} failed` : '',
    ].filter(Boolean).join(' • ')

    const confirmDelete = async (item) => {
        await onDeleteLocalGenome?.(item)
        setPendingDeleteKey('')
    }

    const confirmDeleteAll = async () => {
        await onDeleteAllLocalGenomes?.(deletableItems)
        setPendingDeleteAll(false)
        setPendingDeleteKey('')
    }

    useEffect(() => {
        if (!pendingDeleteKey && !pendingDeleteAll) return undefined
        const clearPendingDelete = () => {
            setPendingDeleteKey('')
            setPendingDeleteAll(false)
        }
        const handleKeyDown = (event) => {
            if (event.key === 'Escape') clearPendingDelete()
        }
        const handlePointerDown = (event) => {
            const target = event.target
            if (target?.closest?.('[data-local-delete-control="true"]')) return
            clearPendingDelete()
        }
        document.addEventListener('keydown', handleKeyDown)
        document.addEventListener('mousedown', handlePointerDown)
        return () => {
            document.removeEventListener('keydown', handleKeyDown)
            document.removeEventListener('mousedown', handlePointerDown)
        }
    }, [pendingDeleteKey, pendingDeleteAll])

    const deleteAllAction = pendingDeleteAll ? (
        <div className="flex items-center gap-1" data-local-delete-control="true">
            <button
                type="button"
                disabled={deletingLocalGenomes || deletableItems.length === 0}
                onClick={confirmDeleteAll}
                className={`px-2 py-1 rounded text-xs font-semibold whitespace-nowrap ${deletingLocalGenomes || deletableItems.length === 0
                    ? 'opacity-40 cursor-not-allowed'
                    : (isLight ? 'bg-red-600 text-white hover:bg-red-700' : 'bg-red-500 text-white hover:bg-red-400')}`}
                title="This will delete all downloaded data listed here."
            >
                Remove all
            </button>
            <button
                type="button"
                onClick={() => setPendingDeleteAll(false)}
                className={`px-1 py-1 rounded text-xs ${isLight ? 'text-gray-500 hover:bg-gray-100' : 'text-gray-400 hover:bg-gray-700'}`}
            >
                Cancel
            </button>
        </div>
    ) : (
        <button
            type="button"
            data-local-delete-control="true"
            disabled={deletableItems.length === 0}
            onClick={() => setPendingDeleteAll(true)}
            className={`p-1 rounded transition-colors ${deletableItems.length === 0
                ? (isLight ? 'text-gray-300 cursor-not-allowed' : 'text-gray-600 cursor-not-allowed')
                : (isLight ? 'text-gray-400 hover:text-red-600 hover:bg-red-50' : 'text-gray-500 hover:text-red-400 hover:bg-red-900/20')}`}
            title={deletableItems.length === 0 ? 'Custom genomes must be deleted manually' : 'Select all listed downloaded data for removal'}
        >
            <IconTrash size={14} />
        </button>
    )

    const renderRow = (item, { active = false } = {}) => {
        const key = getAssemblyGenomeKey(item)
        const localTypes = active ? [] : (Array.isArray(item.types) ? item.types : [])
        const rowPendingDelete = pendingDeleteKey === key
        const canDelete = !active && !!item.download_managed
        const source = item.source_database || normalizeGenomeSourceDatabase(item)
        return (
            <div key={`${active ? 'active' : 'local'}:${key}`} className={rowBase} style={{ gridTemplateColumns: gridCols }}>
                <div className={`px-3 py-2.5 overflow-hidden ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>
                    <div className="font-medium leading-tight truncate" title={item.scientific_name || item.species_key}>{item.scientific_name || item.species_key}</div>
                    {active ? (
                        <div className={`text-xs mt-0.5 truncate ${isLight ? 'text-blue-700' : 'text-blue-300'}`}>Download in progress</div>
                    ) : item.common_name ? (
                        <div className={`text-xs mt-0.5 truncate ${isLight ? 'text-gray-500' : 'text-gray-400'}`} title={item.common_name}>{item.common_name}</div>
                    ) : null}
                </div>
                <div className={`px-3 py-2.5 font-mono text-xs truncate ${isLight ? 'text-gray-600' : 'text-gray-400'}`} title={getAssemblyAccession(item)}>
                    {getAssemblyAccession(item)}
                </div>
                <div className={`px-3 py-2.5 text-xs truncate ${isLight ? 'text-gray-700' : 'text-gray-300'}`} title={item.assembly_name || getAssemblyAccession(item)}>
                    {item.assembly_name || getAssemblyAccession(item)}
                </div>
                <div className={`px-3 py-2.5 text-xs truncate ${isLight ? 'text-gray-500' : 'text-gray-400'}`} title={source}>
                    {source}
                </div>
                <div className="px-3 py-2.5">
                    {rowPendingDelete ? (
                        <div className="flex items-center justify-end gap-1">
                            <button
                                type="button"
                                data-local-delete-control="true"
                                disabled={deletingLocalGenomes}
                                onClick={() => confirmDelete(item)}
                                className={`px-2 py-1 rounded text-xs font-semibold ${deletingLocalGenomes
                                    ? 'opacity-40 cursor-not-allowed'
                                    : (isLight ? 'bg-red-600 text-white hover:bg-red-700' : 'bg-red-500 text-white hover:bg-red-400')}`}
                            >
                                Remove
                            </button>
                            <button
                                type="button"
                                data-local-delete-control="true"
                                disabled={deletingLocalGenomes}
                                onClick={() => setPendingDeleteKey('')}
                                className={`px-1 py-1 rounded text-xs ${isLight ? 'text-gray-500 hover:bg-gray-100' : 'text-gray-400 hover:bg-gray-700'}`}
                            >
                                Cancel
                            </button>
                        </div>
                    ) : (
                        <GenomeRowActions
                            item={item}
                            selectedTypes={selectedTypes}
                            localTypes={localTypes}
                            localFileInfo={active ? null : item}
                            tasksByItemKey={tasksByItemKey}
                            downloading={downloading}
                            isLight={isLight}
                            onDownload={onDownload}
                            onDownloadFiles={onDownloadFiles}
                            onCancelFiles={onCancelFiles}
                            onDeleteFile={onDeleteFile}
                            onDelete={active ? null : () => setPendingDeleteKey(key)}
                            deleteDisabled={!canDelete || deletingLocalGenomes}
                            deleteTitle={canDelete ? 'Remove downloaded files' : (item.delete_blocked_reason || 'Custom genomes must be deleted manually')}
                        />
                    )}
                </div>
            </div>
        )
    }

    return (
        <div className={panelBase} ref={panelRef}>
            <PanelHeader
                title="Local Genomes"
                count={items.length}
                countLabel={countLabel}
                isLight={isLight}
                actions={deleteAllAction}
            />

            <div className={`grid shrink-0 border-t border-b ${borderClass}`} style={{ gridTemplateColumns: gridCols }}>
                <div className={thClass}>Species</div>
                <div className={thClass}>Accession</div>
                <div className={thClass}>Assembly Name</div>
                <div className={thClass}>Source</div>
                <div className={thClass}></div>
            </div>

            {sortedItems.length === 0 && visibleActiveItems.length === 0 ? (
                <div className={`px-4 py-5 text-center text-sm ${isLight ? 'text-gray-400' : 'text-gray-500'}`}>
                    No local genomes found
                </div>
            ) : (
                <div>
                    {visibleActiveItems.map((item) => renderRow(item, { active: true }))}
                    {sortedItems.map((item) => renderRow(item))}
                </div>
            )}
        </div>
    )
}

// ---------------------------------------------------------------------------
// Main DownloadView
// ---------------------------------------------------------------------------

// What the catalogue looked like the last time this view was open. The view is
// unmounted when the user switches away, so without this every visit started
// from an empty list and a spinner, and stayed there until the backend answered
// — which, with a long GFF3 analysis running, could be a very long time. The
// genomes were already fetched this session; showing them straight away and
// refreshing behind the list costs nothing and never leaves the page blank.
const sessionCatalogue = {
    groups: null,
    species: null,
    refSeqGroups: null,
    status: null,
    localAssemblies: null,
    ncbiBrowse: new Map(),
    ncbiSearch: new Map(),
}

export default function DownloadView({
    config,
    theme,
    screenshotMode = false,
    onScreenshotModeChange = null,
    onScreenshotAvailabilityChange = null,
    screenshotToggleButtonRef = null,
}) {
    const isLight = theme === 'light'
    const screenshotRootRef = useRef(null)
    const speciesListScrollRef = useRef(null)
    const [screenshotRootNode, setScreenshotRootNode] = useState(null)
    const [selectedScreenshotTarget, setSelectedScreenshotTarget] = useState(null)
    const setScreenshotRoot = useCallback((node) => {
        screenshotRootRef.current = node
        setScreenshotRootNode(node)
    }, [])

    const [groups, setGroups] = useState(() => sessionCatalogue.groups || [])
    const [allSpecies, setAllSpecies] = useState(() => sessionCatalogue.species || [])
    const [ncbiSpecies, setNcbiSpecies] = useState([])
    const [localAssemblies, setLocalAssemblies] = useState(() => sessionCatalogue.localAssemblies || [])
    // Only the first visit of a session has nothing to show.
    const [loading, setLoading] = useState(() => !sessionCatalogue.species)
    const [activeProvider, setActiveProvider] = useState('ensembl')
    const [ncbiLoading, setNcbiLoading] = useState(false)
    const [activeRefSeqGroup, setActiveRefSeqGroup] = useState('All genomes')
    const [activeRefSeqSubGroup, setActiveRefSeqSubGroup] = useState(null)
    const [refSeqGroups, setRefSeqGroups] = useState(() => sessionCatalogue.refSeqGroups || [])
    const [refSeqGroupsLoading, setRefSeqGroupsLoading] = useState(false)
    const [ncbiCurrentPageToken, setNcbiCurrentPageToken] = useState(null)
    const [ncbiNextPageToken, setNcbiNextPageToken] = useState(null)
    const [ncbiPageTokenHistory, setNcbiPageTokenHistory] = useState([])
    const [ncbiTotalCount, setNcbiTotalCount] = useState(null)
    const [activeGroup, setActiveGroup] = useState('All')
    const [activeSubGroup, setActiveSubGroup] = useState(null)
    const [search, setSearch] = useState('')
    const [page, setPage] = useState(1)
    const [expandedKey, setExpandedKey] = useState(null)
    const [activeDownloadTypes, setActiveDownloadTypes] = useState(() => new Set(DEFAULT_DOWNLOAD_FILE_TYPES))

    const [myList, setMyList] = useState([])
    const [tasks, setTasks] = useState([])
    const [downloading, setDownloading] = useState(false)
    const [deletingLocalGenomes, setDeletingLocalGenomes] = useState(false)
    const [statusMsg, setStatusMsg] = useState(null)
    const [catalogStatus, setCatalogStatus] = useState(() => sessionCatalogue.status)
	    const [refreshingCatalog, setRefreshingCatalog] = useState(false)
	    const seenFailedTaskIdsRef = useRef(new Set())
	    const seenWarningTaskIdsRef = useRef(new Set())
	    const seenCompletedTaskIdsRef = useRef(new Set())
	    const dismissedAutoManagedItemIdsRef = useRef(new Set())
	    const tasksRef = useRef([])
    const lastCatalogFingerprintRef = useRef('')
    // null until the first status reply, so a normal mount does not look like an arrival.
    const catalogueWasAvailableRef = useRef(null)
    const ncbiBrowseCacheRef = useRef(sessionCatalogue.ncbiBrowse)
    const ncbiSearchCacheRef = useRef(sessionCatalogue.ncbiSearch)

    // Panel collapse state
    const [speciesCollapsed, setSpeciesCollapsed] = useState(false)


    // ---------------------------------------------------------------------------
    // Data fetching
    // ---------------------------------------------------------------------------
    useEffect(() => {
        tasksRef.current = tasks
    }, [tasks])

    useEffect(() => {
        const allowed = new Set(activeProvider === 'ncbi' ? REFSEQ_DOWNLOAD_FILE_TYPES : ENSEMBL_DOWNLOAD_FILE_TYPES)
        setActiveDownloadTypes((prev) => {
            const next = new Set([...prev].filter((type) => allowed.has(type)))
            if (next.size === 0) DEFAULT_DOWNLOAD_FILE_TYPES.forEach((type) => allowed.has(type) && next.add(type))
            return next
        })
    }, [activeProvider])

    const fetchLocalAssemblies = useCallback(async () => {
        if (!config?.output_dir) {
            sessionCatalogue.localAssemblies = null
            setLocalAssemblies([])
            return
        }
        try {
            const res = await fetch(`${API_BASE}/api/remote/local-assemblies?output_dir=${encodeURIComponent(config.output_dir)}`)
            if (res.ok) {
                const data = await res.json()
                const assemblies = (Array.isArray(data) ? data : []).map((item) => normalizeGenomeRecord(item))
                sessionCatalogue.localAssemblies = assemblies
                setLocalAssemblies(assemblies)
                const localTypeByKey = new Map()
                for (const entry of assemblies) {
                    const key = getAssemblyGenomeKey(entry)
                    localTypeByKey.set(key, Array.isArray(entry.types) ? entry.types : [])
                }
                const latestByKey = new Map()
                for (const task of tasksRef.current) {
                    const key = getAssemblyGenomeKey(task)
                    const typeKey = task.file_type || `__task__${task.id}`
                    if (!latestByKey.has(key)) latestByKey.set(key, new Map())
                    const typeMap = latestByKey.get(key)
                    const existing = typeMap.get(typeKey)
                    typeMap.set(typeKey, existing ? (pickPreferredTask([existing, task]) || task) : task)
                }
                const inProgressStatuses = new Set(['pending', 'downloading'])
                // Keep My List local type cache in sync with disk state to avoid stale "downloaded" badges.
                setMyList((prev) => prev
                    .map((item) => {
                        const types = localTypeByKey.get(item.id)
                        if (!types) return { ...item, localTypes: [] }
                        return { ...item, localTypes: types }
                    })
                    .filter((item) => {
                        if (!item.autoManaged) return true
                        const latestTasks = Array.from((latestByKey.get(item.id) || new Map()).values())
                        const hasInProgress = latestTasks.some((task) => inProgressStatuses.has(task.status))
                        const hasFailed = latestTasks.some((task) => task.status === 'failed')
                        if (hasInProgress || hasFailed) return true
                        if (!Array.isArray(item.requestedTypes) || item.requestedTypes.length === 0) return true
                        const requiredTypes = item.requestedTypes
                        const localTypes = Array.isArray(item.localTypes) ? item.localTypes : (localTypeByKey.get(item.id) || [])
                        return !requiredTypes.every((type) => localTypes.includes(type))
                    }))
	            } else {
	                console.warn('Failed to refresh local assemblies:', res.statusText)
	            }
	        } catch (error) {
	            console.warn('Failed to refresh local assemblies:', error)
	        }
	    }, [config?.output_dir])

    // While a tutorial is running the demo genome joins the catalogue, so the tutorial
    // can teach this view for real — same search, same file-type chips, same download
    // button — without a network round trip or a gigabyte on disk.
    const { isRunning: tutorialRunning, emitSignal: emitTutorialSignal } = useTutorial()
    const [demoSpecies, setDemoSpecies] = useState(null)

    useEffect(() => {
        if (!tutorialRunning) {
            setDemoSpecies(null)
            return
        }
        let cancelled = false
        fetchDemoGenomeStatus(config?.output_dir || '')
            .then((status) => { if (!cancelled) setDemoSpecies(status?.species || null) })
            .catch(() => { if (!cancelled) setDemoSpecies(null) })
        return () => { cancelled = true }
    }, [config?.output_dir, tutorialRunning])

    // The demo genome is already on the machine, so installing it is instantaneous — which
    // teaches the wrong thing. Pacing it over a few seconds with real-looking progress is
    // the point of the step: this is what waiting for a download looks like.
    const DEMO_DOWNLOAD_MS = 5000
    const [demoProgress, setDemoProgress] = useState(null)

    const handleDemoGenomeInstall = useCallback(async () => {
        if (!config?.output_dir) {
            setStatusMsg({ text: 'Set an Output Directory in Configuration first.', isError: true })
            setTimeout(() => setStatusMsg(null), 4000)
            return
        }
        // Deliberately not a status banner: that banner is in the flow above the species
        // table, so showing one shifts the whole list — including the button just clicked —
        // down by its height. The progress goes on the button's own icon instead, which is
        // where a real download shows it anyway.
        setDemoProgress(0)
        const started = Date.now()
        const ticker = setInterval(() => {
            setDemoProgress(Math.min(0.99, (Date.now() - started) / DEMO_DOWNLOAD_MS))
        }, 60)
        try {
            // Do the real work while the progress runs, then hold until the clock catches
            // up so the pacing is the same whether or not the disk was quick.
            const install = installDemoGenome(config.output_dir)
            await Promise.all([
                install,
                new Promise((resolve) => setTimeout(resolve, DEMO_DOWNLOAD_MS)),
            ])
            clearInterval(ticker)
            setDemoProgress(1)
            await fetchLocalAssemblies()
            // Cleared only once the listing has caught up, so the icon goes straight from
            // a full ring to the downloaded tick rather than flicking back in between.
            setDemoProgress(null)
            emitTutorialSignal('demoGenome.installed')
        } catch (error) {
            clearInterval(ticker)
            setDemoProgress(null)
            setStatusMsg({ text: `Could not install the demo genome: ${error?.message || 'Unknown error'}`, isError: true })
            setTimeout(() => setStatusMsg(null), 5000)
        } finally {
            clearInterval(ticker)
        }
    }, [config?.output_dir, emitTutorialSignal, fetchLocalAssemblies])

    const fetchRemoteCatalogData = useCallback(async () => {
        const [gRes, sRes] = await Promise.all([
            fetch(`${API_BASE}/api/remote/groups?provider=ensembl`),
            fetch(`${API_BASE}/api/remote/species?provider=ensembl`),
        ])
        if (!gRes.ok || !sRes.ok) throw new Error('Failed to load remote catalogue')
        const fetchedGroups = await gRes.json()
        const fetchedSpecies = (await sRes.json()).map((item) => normalizeRemoteSpecies(item, 'ensembl'))

        let modelsCount = 0
        fetchedSpecies.forEach((s) => {
            const matchingAssemblies = s.assemblies?.filter((a) =>
                matchesModelOrganism(s.key, a)
            ) || []
            if (matchingAssemblies.length > 0) {
                modelsCount += matchingAssemblies.length
            }
        })

        const nextGroups = [
            { name: 'Models', count: modelsCount },
            ...fetchedGroups,
        ]
        sessionCatalogue.groups = nextGroups
        sessionCatalogue.species = fetchedSpecies
        setGroups(nextGroups)
        setAllSpecies(fetchedSpecies)
    }, [])

    const fetchNcbiSearchResults = useCallback(async (pageToken = null) => {
        const query = search.trim()
        if (activeProvider !== 'ncbi') return

        // A page already fetched this session is served from the cache below, so
        // only an actual round trip is worth a spinner.
        const willFetch = query
            ? !ncbiSearchCacheRef.current.has(`search:${query.toLowerCase()}`)
            : !ncbiBrowseCacheRef.current.has(`browse:${activeRefSeqGroup}:${pageToken || ''}`)
        setNcbiLoading(willFetch)
        try {
            if (!query) {
                const tokenParam = pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ''
                const cacheKey = `browse:${activeRefSeqGroup}:${pageToken || ''}`
                let data = ncbiBrowseCacheRef.current.get(cacheKey)
                if (!data) {
                    const res = await fetch(
                        `${API_BASE}/api/remote/ncbi/browse?group=${encodeURIComponent(activeRefSeqGroup)}&page_size=${PAGE_SIZE}${tokenParam}`
                    )
                    data = await res.json().catch(() => ({}))
                    if (!res.ok) throw new Error(data?.detail || 'Failed to load RefSeq group')
                    ncbiBrowseCacheRef.current.set(cacheKey, data)
                }
                const fetched = Array.isArray(data?.species) ? data.species.map((item) => normalizeRemoteSpecies(item, 'ncbi')) : []
                setNcbiSpecies(fetched)
                setNcbiCurrentPageToken(pageToken || null)
                setNcbiNextPageToken(data?.next_page_token || null)
                setNcbiTotalCount(typeof data?.total_count === 'number' ? data.total_count : null)
                return
            }

            const cacheKey = `search:${query.toLowerCase()}`
            let data = ncbiSearchCacheRef.current.get(cacheKey)
            if (!data) {
                const res = await fetch(
                    `${API_BASE}/api/remote/ncbi/search?query=${encodeURIComponent(query)}&assembly_source=refseq&page_size=${PAGE_SIZE}`
                )
                data = await res.json().catch(() => ({}))
                if (!res.ok) throw new Error(data?.detail || 'Failed to search RefSeq genomes')
                ncbiSearchCacheRef.current.set(cacheKey, data)
            }
            setNcbiSpecies(Array.isArray(data?.species) ? data.species.map((item) => normalizeRemoteSpecies(item, 'ncbi')) : [])
            setNcbiCurrentPageToken(null)
            setNcbiNextPageToken(null)
            setNcbiPageTokenHistory([])
            setNcbiTotalCount(typeof data?.total_count === 'number' ? data.total_count : null)
        } catch (e) {
            setStatusMsg({ text: `RefSeq search failed: ${e?.message || 'Unknown error'}`, isError: true })
            setTimeout(() => setStatusMsg(null), 5000)
        } finally {
            setNcbiLoading(false)
        }
    }, [activeProvider, activeRefSeqGroup, search])

    const fetchCatalogStatus = useCallback(async () => {
        const res = await fetch(`${API_BASE}/api/remote/catalog/status`)
        if (!res.ok) throw new Error('Failed to load catalogue status')
        const data = await res.json()
        sessionCatalogue.status = data
        setCatalogStatus(data)
        return data
    }, [])

    const fetchRefSeqGroups = useCallback(async () => {
        setRefSeqGroupsLoading(!sessionCatalogue.refSeqGroups)
        try {
            const res = await fetch(`${API_BASE}/api/remote/groups?provider=ncbi`)
            const data = await res.json().catch(() => ([]))
            sessionCatalogue.refSeqGroups = Array.isArray(data) ? data : []
            setRefSeqGroups(sessionCatalogue.refSeqGroups)
        } catch (error) {
            console.warn('Failed to refresh RefSeq groups:', error)
        } finally {
            setRefSeqGroupsLoading(false)
        }
    }, [])

    useEffect(() => {
        const init = async () => {
            // Revisiting the view refreshes behind whatever is already on screen;
            // only a first, empty mount is allowed to show the spinner.
            const hasCachedSpecies = !!sessionCatalogue.species
            if (!hasCachedSpecies) setLoading(true)
            try {
                const [status] = await Promise.all([
                    fetchCatalogStatus(),
                    fetchRemoteCatalogData(),
                ])
                lastCatalogFingerprintRef.current = String(status?.current_catalog_fingerprint || '')
            } catch (e) { console.error('Failed to load data', e) }
            finally { if (!hasCachedSpecies) setLoading(false) }
        }
        init()
    }, [fetchCatalogStatus, fetchRemoteCatalogData])

    useEffect(() => {
        fetchLocalAssemblies()
    }, [fetchLocalAssemblies])

    // Fetch RefSeq group counts when the RefSeq tab is activated (cached 1hr on backend)
    useEffect(() => {
        if (activeProvider !== 'ncbi') return
        fetchRefSeqGroups()
    }, [activeProvider, fetchRefSeqGroups])

    useEffect(() => {
        if (activeProvider !== 'ncbi') return undefined
        const timer = window.setTimeout(() => {
            fetchNcbiSearchResults()
        }, 200)
        return () => window.clearTimeout(timer)
    }, [activeProvider, fetchNcbiSearchResults, activeRefSeqGroup, search])

    useEffect(() => {
        let cancelled = false
        const pollCatalogStatus = async () => {
            try {
                const status = await fetchCatalogStatus()
                if (cancelled || !status) return
                const nextFingerprint = String(status.current_catalog_fingerprint || '')
                const previousFingerprint = String(lastCatalogFingerprintRef.current || '')
                const catalogueAvailable = Boolean(status.catalog_available)
                const fingerprintChanged = Boolean(
                    nextFingerprint && previousFingerprint && nextFingerprint !== previousFingerprint
                )
                // The very first catalogue to arrive has no earlier fingerprint to differ
                // from, so the comparison above cannot see it. Without this the view stays
                // empty until the user reloads.
                const catalogueJustArrived = catalogueWasAvailableRef.current === false && catalogueAvailable
                if (fingerprintChanged || catalogueJustArrived) {
                    await fetchRemoteCatalogData()
                    if (typeof window !== 'undefined') {
                        window.dispatchEvent(new Event(SELECTOR_REFRESH_EVENT))
                    }
                }
                catalogueWasAvailableRef.current = catalogueAvailable
                if (nextFingerprint) {
                    lastCatalogFingerprintRef.current = nextFingerprint
                }
            } catch {
                // keep silent during catalogue polling
            }
        }
        pollCatalogStatus()
        const id = window.setInterval(pollCatalogStatus, 5000)
        return () => {
            cancelled = true
            window.clearInterval(id)
        }
    }, [fetchCatalogStatus, fetchRemoteCatalogData])

    useEffect(() => {
        const nextPendingIds = new Set(
            myList
                .filter((item) => item.autoManaged)
                .map((item) => String(item.id || '').trim())
                .filter(Boolean)
        )
        const previousPendingIds = readPendingSelectorGenomeIds()
        const removedIds = Array.from(previousPendingIds).filter((id) => !nextPendingIds.has(id))
        const changed = removedIds.length > 0 || previousPendingIds.size !== nextPendingIds.size
        if (!changed) return
        writePendingSelectorGenomeIds(nextPendingIds)
        if (removedIds.length > 0 && typeof window !== 'undefined') {
            window.dispatchEvent(new Event(SELECTOR_REFRESH_EVENT))
        }
    }, [myList])

    useEffect(() => {
        const poll = async () => {
            try {
                const res = await fetch(`${API_BASE}/api/remote/tasks`)
                if (res.ok) {
                    const newTasks = await res.json()
                    setTasks(newTasks)
                    const latestByKey = new Map()
                    for (const task of newTasks) {
                        const key = getAssemblyGenomeKey(task)
                        const typeKey = task.file_type || `__task__${task.id}`
                        if (!latestByKey.has(key)) latestByKey.set(key, new Map())
                        const typeMap = latestByKey.get(key)
                        const existing = typeMap.get(typeKey)
                        if (!existing) {
                            typeMap.set(typeKey, task)
                            continue
                        }
                        const next = pickPreferredTask([existing, task]) || task
                        typeMap.set(typeKey, next)
                    }

                    const latestTasksForKey = (key) => Array.from((latestByKey.get(key) || new Map()).values())
                    const inProgressStatuses = new Set(['pending', 'downloading'])
                    const inProgressKeys = new Set()
                    const failedKeys = new Set()
                    const newlyCompletedTasks = []

                    for (const [key, taskMap] of latestByKey.entries()) {
                        const latestTasks = Array.from(taskMap.values())
                        const hasInProgress = latestTasks.some((task) => inProgressStatuses.has(task.status))
                        const hasFailed = latestTasks.some((task) => task.status === 'failed')
                        const hasCompleted = latestTasks.some((task) => task.status === 'completed')
                        if (hasInProgress) inProgressKeys.add(key)
                        if (hasFailed) failedKeys.add(key)
                    }

                    for (const task of newTasks) {
                        if (task.status !== 'completed') continue
                        if (seenCompletedTaskIdsRef.current.has(task.id)) continue
                        seenCompletedTaskIdsRef.current.add(task.id)
                        newlyCompletedTasks.push(task)
                    }

                    const newFailedTasks = []
                    for (const task of newTasks) {
                        if (task.status !== 'failed') continue
                        if (seenFailedTaskIdsRef.current.has(task.id)) continue
                        seenFailedTaskIdsRef.current.add(task.id)
                        newFailedTasks.push(task)
                    }
                    if (newFailedTasks.length > 0) {
                        const first = newFailedTasks[0]
                        const label = first.file_type ? `${fileTypeLabel(first.file_type)} for ${first.assembly}` : first.filename
                        setStatusMsg({ text: `Download failed: ${label}`, isError: true })
                        setTimeout(() => setStatusMsg(null), 6000)
                    } else {
                        const newWarningTasks = []
                        for (const task of newTasks) {
                            if (task.status !== 'completed') continue
                            if (!String(task.warning || '').trim()) continue
                            if (seenWarningTaskIdsRef.current.has(task.id)) continue
                            seenWarningTaskIdsRef.current.add(task.id)
                            newWarningTasks.push(task)
                        }
                        if (newWarningTasks.length > 0) {
                            const first = newWarningTasks[0]
                            const fallbackLabel = first.file_type ? `${fileTypeLabel(first.file_type)} for ${first.assembly}` : first.filename
                            setStatusMsg({
                                text: String(first.warning || `Softmasked file unavailable; used unmasked fallback for ${fallbackLabel}.`),
                                isError: false,
                                isWarning: true,
                            })
                            setTimeout(() => setStatusMsg(null), 7000)
                        }
                    }

                    setMyList((prev) => {
                        let next = prev.slice()

                        const existingIds = new Set(next.map((i) => i.id))
	                        const dismissedIds = dismissedAutoManagedItemIdsRef.current
	                        const keysToSurface = new Set([...inProgressKeys, ...failedKeys].filter((key) => !dismissedIds.has(key)))
                        for (const key of keysToSurface) {
                            if (existingIds.has(key)) continue
                            const taskSeed = newTasks.find((task) => getAssemblyGenomeKey(task) === key)
                            const provider = normalizeGenomeProvider(taskSeed)
                            const speciesKey = taskSeed?.species_key || ''
                            const assembly = taskSeed?.assembly || ''
                            const speciesPool = provider === 'ncbi' ? ncbiSpecies : allSpecies
                            const species = speciesPool.find((s) => s.key === speciesKey)
                            const asm = species?.assemblies?.find((a) => getAssemblyAccession(a) === assembly)
                            const latest = latestTasksForKey(key)
                            const requestedTypes = [...new Set(latest.map((t) => t.file_type).filter(Boolean))]
                            next.push({
                                id: key,
                                provider,
                                source_database: asm?.source_database || normalizeGenomeSourceDatabase({ provider, assembly }),
                                species_key: speciesKey,
                                scientific_name: species?.scientific_name || speciesKey.replace(/_/g, ' '),
                                common_name: species?.common_name || '',
                                display_name: species?.display_name || '',
                                display_name_reason: species?.display_name_reason || '',
                                assembly,
                                gca: assembly,
                                assembly_name: asm?.name || assembly,
                                equivalent_accessions: asm?.equivalent_accessions || [],
                                autoManaged: true,
                                requestedTypes,
                                localTypes: undefined,
                            })
                        }

                        // Auto-managed entries disappear only once all requested local files are present.
                        next = next.filter((item) => {
                            if (!item.autoManaged) return true
                            const latest = latestTasksForKey(item.id)
                            const hasInProgress = latest.some((task) => inProgressStatuses.has(task.status))
                            const hasFailed = latest.some((task) => task.status === 'failed')
                            if (hasInProgress || hasFailed) return true
                            if (!Array.isArray(item.requestedTypes) || item.requestedTypes.length === 0) return true
                            const requiredTypes = item.requestedTypes
                            const localTypes = Array.isArray(item.localTypes) ? item.localTypes : []
                            const isComplete = requiredTypes.every((type) => localTypes.includes(type))
                            return !isComplete
                        })

                        return next
                    })

                    if (newlyCompletedTasks.length > 0) fetchLocalAssemblies()
                }
            } catch { /* ignore */ }
        }
        poll()
        const id = setInterval(poll, 2000)
        return () => clearInterval(id)
    }, [allSpecies, fetchLocalAssemblies, ncbiSpecies])

    const sidebarGroups = useMemo(() => {
        if (activeProvider !== 'ensembl') return []
        const baseGroups = groups.filter(g => g.name !== 'Local genomes')
        return [
            ...baseGroups,
            { name: 'Local genomes', count: localAssemblies.length, sub_groups: [] }
        ]
    }, [activeProvider, groups, localAssemblies.length])

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
        return `${API_BASE}/api/remote/files/${item.species_key}/${encodeURIComponent(getAssemblyAccession(item))}?${params.toString()}`
    }, [])

    const buildAvailabilityUrl = useCallback((item, includeDirectoryListing = false) => {
        const params = new URLSearchParams({
            provider: normalizeGenomeProvider(item),
        })
        if (includeDirectoryListing) params.set('include_directory_listing', 'true')
        return `${API_BASE}/api/remote/files/${item.species_key}/${encodeURIComponent(getAssemblyAccession(item))}/availability?${params.toString()}`
    }, [])

    const markItemsActive = useCallback((items, filesByItem) => {
        setMyList((prev) => {
            const byId = new Map(prev.map((item) => [item.id, item]))
            for (const item of items) {
                const fileTypes = [...new Set((filesByItem.get(item.id) || []).map((file) => file.type).filter(Boolean))]
                const existing = byId.get(item.id)
                byId.set(item.id, {
                    ...(existing || item),
                    ...item,
                    autoManaged: true,
                    localTypes: undefined,
                    requestedTypes: [
                        ...new Set([
                            ...(Array.isArray(existing?.requestedTypes) ? existing.requestedTypes : []),
                            ...fileTypes,
                        ]),
                    ],
                })
                dismissedAutoManagedItemIdsRef.current.delete(item.id)
            }
            return Array.from(byId.values())
        })
    }, [])

    const postDownloadFile = useCallback(async (item, file, { force = false } = {}) => {
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
                taxid: Number(item.taxid) || 0,
                ...datasetReleaseDownloadMetadata(file),
                force,
            }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data?.detail || `Failed to start ${file.type || 'file'} download`)
        return data
    }, [config?.output_dir])

    const handleDownloadFiles = useCallback(async (item, files, { force = false } = {}) => {
        if (!config?.output_dir) {
            setStatusMsg({ text: 'Set an Output Directory in Configuration first.', isError: true })
            setTimeout(() => setStatusMsg(null), 4000)
            return
        }
        const queuedFiles = Array.isArray(files) ? files.filter((file) => file?.url && file?.filename) : []
        if (queuedFiles.length === 0) {
            setStatusMsg({ text: 'No matching files are available for this genome.', isError: true })
            setTimeout(() => setStatusMsg(null), 4000)
            return
        }
        setDownloading(true)
        let started = 0
        let alreadyLocal = 0
        let alreadyQueued = 0
        try {
            for (const file of queuedFiles) {
                const data = await postDownloadFile(item, file, { force })
                if (data?.status === 'started' || data?.status === 'pending' || data?.status === 'downloading') started++
                else if (data?.status === 'already_exists' || data?.status === 'completed') alreadyLocal++
                else alreadyQueued++
            }
            if (started > 0) markItemsActive([item], new Map([[item.id, queuedFiles]]))
            if (alreadyLocal > 0) fetchLocalAssemblies()
            const parts = []
            if (started > 0) parts.push(`Started ${started} file download${started !== 1 ? 's' : ''}`)
            if (alreadyQueued > 0) parts.push(`${alreadyQueued} already queued`)
            if (alreadyLocal > 0) parts.push(`${alreadyLocal} already present locally`)
            setStatusMsg({ text: `${parts.length ? parts.join(' • ') : 'No new downloads were needed'}.`, isError: false })
            setTimeout(() => setStatusMsg(null), 5000)
        } catch (e) {
            setStatusMsg({ text: `Download failed: ${e?.message || 'Unknown error'}`, isError: true })
            setTimeout(() => setStatusMsg(null), 6000)
        } finally {
            setDownloading(false)
        }
    }, [config?.output_dir, fetchLocalAssemblies, markItemsActive, postDownloadFile])

    const handleCancelDownloadFiles = useCallback(async (item, files) => {
        const selectedFiles = Array.isArray(files) ? files : []
        const fileTypes = [...new Set(selectedFiles.map((file) => String(file?.type || '').trim()).filter(Boolean))]
        const filenames = [...new Set(selectedFiles.map((file) => gcaPrefixedDownloadFilename(file, item)).filter(Boolean))]
        if (fileTypes.length === 0 && filenames.length === 0) return
        try {
            const res = await fetch(`${API_BASE}/api/remote/download/cancel`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    provider: normalizeGenomeProvider(item),
                    species_key: item.species_key,
                    assembly: getAssemblyAccession(item),
                    file_types: fileTypes,
                    filenames,
                }),
            })
            const data = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(data?.detail || 'Failed to cancel downloads')
            const cancelledIds = new Set(Array.isArray(data?.task_ids) ? data.task_ids : [])
            if (cancelledIds.size > 0) {
                setTasks((prev) => prev.map((task) => (
                    cancelledIds.has(task.id)
                        ? { ...task, status: 'canceled', progress: 0, error: null, cancel_requested: true }
                        : task
                )))
            }
            setStatusMsg({
                text: cancelledIds.size > 0
                    ? `Canceled ${cancelledIds.size} download${cancelledIds.size === 1 ? '' : 's'}.`
                    : 'No active downloads matched that selection.',
                isError: false,
            })
            setTimeout(() => setStatusMsg(null), 4000)
        } catch (e) {
            setStatusMsg({ text: `Cancel failed: ${e?.message || 'Unknown error'}`, isError: true })
            setTimeout(() => setStatusMsg(null), 5000)
        }
    }, [])

    const handleRowDownload = useCallback(async (item, { force = false, selectedTypes = null } = {}) => {
        if (isDemoGenomeItem(item)) {
            await handleDemoGenomeInstall()
            return
        }
        const requestedTypes = Array.isArray(selectedTypes) ? selectedTypes : Array.from(activeDownloadTypes)
        if (requestedTypes.length === 0) {
            setStatusMsg({ text: 'Select at least one file type to download.', isError: true })
            setTimeout(() => setStatusMsg(null), 4000)
            return
        }
        try {
            const res = await fetch(buildAvailabilityUrl(item, false))
            const availability = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(availability?.detail || 'Could not load available files')
            const files = chooseFilesForTypes(availability, requestedTypes)
            await handleDownloadFiles(item, files, { force })
        } catch (e) {
            setStatusMsg({ text: `Download failed: ${e?.message || 'Unknown error'}`, isError: true })
            setTimeout(() => setStatusMsg(null), 6000)
        }
    }, [activeDownloadTypes, buildAvailabilityUrl, handleDemoGenomeInstall, handleDownloadFiles])

    const handleDownloadAllAssemblies = useCallback(async (species, options = {}) => {
        const assemblies = Array.isArray(species?.assemblies) ? species.assemblies : []
        for (const asm of assemblies) {
            const item = itemFromSpeciesAssembly(species, asm)
            const itemTypes = options?.selectedTypesByItem?.[item.id]
            if (Array.isArray(itemTypes) && itemTypes.length === 0) continue
            await handleRowDownload(item, { selectedTypes: itemTypes })
        }
    }, [handleRowDownload])

    const deleteLocalGenome = useCallback(async (item) => {
        if (!config?.output_dir || !item) return
        if (!item.download_managed) {
            setStatusMsg({ text: item.delete_blocked_reason || 'Custom genomes must be deleted manually', isError: true })
            setTimeout(() => setStatusMsg(null), 5000)
            return
        }
        const res = await fetch(`${API_BASE}/api/remote/local-files`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                output_dir: config.output_dir,
                species_key: item.species_key,
                assembly: getAssemblyAccession(item),
                provider: normalizeGenomeProvider(item),
            }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data?.detail || 'Failed to remove downloaded files')
    }, [config?.output_dir])

    const handleDeleteLocalGenome = useCallback(async (item) => {
        setDeletingLocalGenomes(true)
        try {
            await deleteLocalGenome(item)
            await fetchLocalAssemblies()
            if (typeof window !== 'undefined') window.dispatchEvent(new Event(SELECTOR_REFRESH_EVENT))
            setStatusMsg({ text: 'Downloaded files removed.', isError: false })
            setTimeout(() => setStatusMsg(null), 3500)
        } catch (e) {
            setStatusMsg({ text: `Remove failed: ${e?.message || 'Unknown error'}`, isError: true })
            setTimeout(() => setStatusMsg(null), 6000)
        } finally {
            setDeletingLocalGenomes(false)
        }
    }, [deleteLocalGenome, fetchLocalAssemblies])

    const handleDeleteLocalFile = useCallback(async (item, file, filePath) => {
        if (!config?.output_dir || !item || !filePath) return
        try {
            const res = await fetch(`${API_BASE}/api/remote/local-file`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    output_dir: config.output_dir,
                    species_key: item.species_key,
                    assembly: getAssemblyAccession(item),
                    provider: normalizeGenomeProvider(item),
                    file_path: filePath,
                }),
            })
            const data = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(data?.detail || 'Failed to delete file')
            await fetchLocalAssemblies()
            if (typeof window !== 'undefined') window.dispatchEvent(new Event(SELECTOR_REFRESH_EVENT))
            setStatusMsg({ text: `Deleted ${fileTypeLabel(file?.type)} file.`, isError: false })
            setTimeout(() => setStatusMsg(null), 3500)
        } catch (e) {
            setStatusMsg({ text: `Delete failed: ${e?.message || 'Unknown error'}`, isError: true })
            setTimeout(() => setStatusMsg(null), 6000)
        }
    }, [config?.output_dir, fetchLocalAssemblies])

    const handleDeleteAllLocalGenomes = useCallback(async (itemsToDelete) => {
        const targets = (Array.isArray(itemsToDelete) ? itemsToDelete : []).filter((item) => item?.download_managed)
        if (targets.length === 0) return
        setDeletingLocalGenomes(true)
        try {
            for (const item of targets) {
                await deleteLocalGenome(item)
            }
            await fetchLocalAssemblies()
            if (typeof window !== 'undefined') window.dispatchEvent(new Event(SELECTOR_REFRESH_EVENT))
            setStatusMsg({ text: `Removed downloaded files for ${targets.length} genome${targets.length === 1 ? '' : 's'}.`, isError: false })
            setTimeout(() => setStatusMsg(null), 4000)
        } catch (e) {
            setStatusMsg({ text: `Remove all failed: ${e?.message || 'Unknown error'}`, isError: true })
            setTimeout(() => setStatusMsg(null), 6000)
        } finally {
            setDeletingLocalGenomes(false)
        }
    }, [deleteLocalGenome, fetchLocalAssemblies])

    // Fetch remote available types and local (already downloaded) types for each item
    useEffect(() => {
        myList.forEach(item => {
            // Check remote available types
            if (item.availableTypes === undefined) {
                setMyList(prev => prev.map(i => i.id === item.id ? { ...i, availableTypes: null } : i))
                fetch(buildRemoteFilesUrl(item))
                    .then(r => r.ok ? r.json() : [])
                    .then(files => {
                        const types = [...new Set(files.map(f => f.type))]
                        setMyList(prev => prev.map(i => i.id === item.id ? { ...i, availableTypes: types } : i))
                    })
                    .catch(() => setMyList(prev => prev.map(i => i.id === item.id ? { ...i, availableTypes: [] } : i)))
            }
            // Check local_data for already-downloaded files
            if (item.localTypes === undefined && config?.output_dir) {
                setMyList(prev => prev.map(i => i.id === item.id ? { ...i, localTypes: null } : i))
                fetch(`${API_BASE}/api/remote/local-files?output_dir=${encodeURIComponent(config.output_dir)}&species_key=${encodeURIComponent(item.species_key)}&assembly=${encodeURIComponent(getAssemblyAccession(item))}&provider=${encodeURIComponent(normalizeGenomeProvider(item))}`)
                    .then(r => r.ok ? r.json() : { types: [] })
                    .then(data => {
                        setMyList(prev => prev.map(i => i.id === item.id ? { ...i, localTypes: data.types || [] } : i))
                    })
                    .catch(() => setMyList(prev => prev.map(i => i.id === item.id ? { ...i, localTypes: [] } : i)))
            }
        })
    }, [buildRemoteFilesUrl, myList, config?.output_dir])

    const totalAssemblies = useMemo(() => {
        const speciesList = activeProvider === 'ncbi' ? ncbiSpecies : allSpecies
        return speciesList.reduce((sum, s) => sum + (s.assemblies?.length || 0), 0)
    }, [activeProvider, allSpecies, ncbiSpecies])

    // ---------------------------------------------------------------------------
    // Tasks keyed by provider-aware genome id for badge status
    // ---------------------------------------------------------------------------
    const tasksByItemKey = useMemo(() => {
        const map = {}
        tasks.forEach(task => {
            const key = getAssemblyGenomeKey(task)
            if (!map[key]) map[key] = []
            map[key].push(task)
        })
        return map
    }, [tasks])

    const localTypeByKey = useMemo(() => {
        const map = new Map()
        localAssemblies.forEach((item) => {
            map.set(getAssemblyGenomeKey(item), Array.isArray(item.types) ? item.types : [])
        })
        return map
    }, [localAssemblies])

    const localFileInfoByKey = useMemo(() => {
        const map = new Map()
        localAssemblies.forEach((item) => {
            map.set(getAssemblyGenomeKey(item), item)
        })
        return map
    }, [localAssemblies])

    const localSearchMatches = useCallback((item, query) => {
        if (!query) return true
        return [
            item?.scientific_name,
            item?.common_name,
            item?.species_key,
            item?.assembly_name,
            item?.source_database,
            getAssemblyAccession(item),
        ].some((value) => String(value || '').toLowerCase().includes(query))
    }, [])

    const filteredLocalAssemblies = useMemo(() => {
        const q = search.toLowerCase().trim()
        return localAssemblies.filter((item) => localSearchMatches(item, q))
    }, [localAssemblies, localSearchMatches, search])

    const filteredActiveLocalItems = useMemo(() => {
        const q = search.toLowerCase().trim()
        return myList
            .filter((item) => item.autoManaged)
            .filter((item) => localSearchMatches(item, q))
    }, [localSearchMatches, myList, search])

    // ---------------------------------------------------------------------------
    // Filtered / paginated species
    // ---------------------------------------------------------------------------
    const filteredSpecies = useMemo(() => {
        if (activeProvider === 'ncbi') {
            let list = ncbiSpecies

            if (activeRefSeqGroup === 'Featured') {
                list = list
                    .map((species) => {
                        const matchingAssemblies = (species.assemblies || []).filter((assembly) =>
                            REFSEQ_FEATURED_ACCESSIONS.has(getAssemblyAccession(assembly))
                        )
                        return matchingAssemblies.length > 0 ? { ...species, assemblies: matchingAssemblies } : null
                    })
                    .filter(Boolean)
            } else if (activeRefSeqGroup === 'Vertebrates') {
                list = list.filter((species) => VERTEBRATE_GROUPS.has(species.group))
            } else if (activeRefSeqGroup === 'Invertebrates') {
                list = list.filter((species) => REFSEQ_INVERTEBRATE_GROUPS.has(species.group))
            } else if (activeRefSeqGroup === 'Microbes') {
                list = list.filter((species) => REFSEQ_MICROBE_GROUPS.has(species.group))
            } else if (activeRefSeqGroup && activeRefSeqGroup !== 'All genomes') {
                list = list.filter((species) => species.group === activeRefSeqGroup)
            }

            if (search.trim()) {
                const q = search.toLowerCase().trim()
                list = list
                    .map((s) => {
                        const scientificMatch = s.scientific_name?.toLowerCase().includes(q)
                        const commonMatch = s.common_name?.toLowerCase().includes(q)
                        const sourceMatch = (s.assemblies || []).some((a) =>
                            String(a.source_database || '').toLowerCase().includes(q)
                        )
                        const matchingAssemblies = (s.assemblies || []).filter((a) =>
                            getAssemblyAccession(a).toLowerCase().includes(q)
                            || String(a.name || '').toLowerCase().includes(q)
                            || String(a.source_database || '').toLowerCase().includes(q)
                        )
                        if (scientificMatch || commonMatch || sourceMatch) return s
                        if (matchingAssemblies.length > 0) return { ...s, assemblies: matchingAssemblies }
                        return null
                    })
                    .filter(Boolean)
            }
            return list
        }
        let list = demoSpecies ? [demoSpecies, ...allSpecies] : allSpecies

        if (activeGroup === 'Models') {
            // Filter species to only those in the MODEL_ORGANISMS list
            list = list.map(s => {
                const matchingAssemblies = s.assemblies?.filter(a =>
                    matchesModelOrganism(s.key, a)
                )
                if (matchingAssemblies && matchingAssemblies.length > 0) {
                    return { ...s, assemblies: matchingAssemblies }
                }
                return null
            }).filter(Boolean)
        } else if (activeGroup === 'Projects') {
            const requestedProject = String(activeSubGroup || '').trim()
            list = list.map(s => {
                const matchingAssemblies = (s.assemblies || []).filter(a => {
                    const projects = Array.isArray(a.projects) ? a.projects : []
                    if (requestedProject) return projects.includes(requestedProject)
                    return projects.length > 0
                })
                if (matchingAssemblies.length > 0) {
                    return { ...s, assemblies: matchingAssemblies }
                }
                return null
            }).filter(Boolean)
        } else if (activeGroup === 'Local genomes') {
            const localAssemblySet = new Set(localAssemblies.map((a) => getAssemblyGenomeKey(a)))
            list = list.map(s => {
                const matchingAssemblies = s.assemblies?.filter(a =>
                    localAssemblySet.has(getAssemblyGenomeKey({ provider: s.provider, species_key: s.key, assembly: getAssemblyAccession(a) }))
                ) || []
                if (matchingAssemblies.length > 0) {
                    return { ...s, assemblies: matchingAssemblies }
                }
                return null
            }).filter(Boolean)
        } else if (activeGroup === 'Vertebrates') {
            list = list.filter(s => VERTEBRATE_GROUPS.has(s.group))
        } else if (activeGroup !== 'All') {
            list = list.filter(s => s.group === activeGroup)
        }

        if (activeSubGroup && activeGroup !== 'Projects') list = list.filter(s => s.sub_group === activeSubGroup)
        if (search.trim()) {
            const q = search.toLowerCase().trim()
            list = list
                .map((s) => {
                    const scientificMatch = s.scientific_name?.toLowerCase().includes(q)
                    const commonMatch = s.common_name?.toLowerCase().includes(q)
                    const sourceMatch = (s.assemblies || []).some((a) =>
                        String(a.source_database || '').toLowerCase().includes(q)
                    )
                    const matchingAssemblies = (s.assemblies || []).filter((a) =>
                        getAssemblyAccession(a).toLowerCase().includes(q)
                        || String(a.name || '').toLowerCase().includes(q)
                        || String(a.source_database || '').toLowerCase().includes(q)
                    )

                    // If query matches species/common name, keep all assemblies for that species.
                    if (scientificMatch || commonMatch || sourceMatch) return s
                    // If query matches only assembly fields, keep just matching assembly rows.
                    if (matchingAssemblies.length > 0) return { ...s, assemblies: matchingAssemblies }
                    return null
                })
                .filter(Boolean)
        }
        return list
    }, [activeProvider, allSpecies, demoSpecies, activeGroup, activeSubGroup, ncbiSpecies, search, localAssemblies, activeRefSeqGroup])

    const totalPages = Math.ceil(filteredSpecies.length / PAGE_SIZE)
    const pageSpecies = filteredSpecies.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
    useEffect(() => { setPage(1) }, [activeGroup, activeProvider, activeSubGroup, activeRefSeqGroup, activeRefSeqSubGroup, search])

    useEffect(() => {
        const node = speciesListScrollRef.current
        if (!node) return undefined
        const resetScroll = () => {
            node.scrollTop = 0
        }
        resetScroll()
        const frame = window.requestAnimationFrame(resetScroll)
        return () => window.cancelAnimationFrame(frame)
    }, [activeProvider, activeGroup, activeSubGroup, activeRefSeqGroup, activeRefSeqSubGroup, search, page])

    // ---------------------------------------------------------------------------
    // My list management
    // ---------------------------------------------------------------------------
    const makeItemId = useCallback((provider, key, assembly) => (
        getAssemblyGenomeKey({ provider, species_key: key, assembly })
    ), [])
    const myListIds = useMemo(() => new Set(myList.map(i => i.id)), [myList])

	    const addToList = useCallback((species, asm) => {
	        const id = makeItemId(species.provider, species.key, getAssemblyAccession(asm))
	        if (myListIds.has(id)) return
	        dismissedAutoManagedItemIdsRef.current.delete(id)
	        setMyList(prev => [...prev, {
            id,
            provider: normalizeGenomeProvider(species),
            source_database: asm?.source_database || normalizeGenomeSourceDatabase({ provider: species.provider, assembly: getAssemblyAccession(asm) }),
            species_key: species.key,
            scientific_name: species.scientific_name,
            common_name: species.common_name,
            display_name: species.display_name || '',
            display_name_reason: species.display_name_reason || '',
            assembly: getAssemblyAccession(asm),
            gca: asm.gca || getAssemblyAccession(asm),
            assembly_name: asm.name,
            equivalent_accessions: asm?.equivalent_accessions || [],
            taxid: Number(species.taxid || species.species_taxonomy_id) || 0,
            requestedTypes: [],
        }])
    }, [myListIds, makeItemId])

	    const removeFromList = useCallback((id) => {
	        setMyList((prev) => {
	            const removed = prev.find((item) => item.id === id)
	            if (removed?.autoManaged) dismissedAutoManagedItemIdsRef.current.add(id)
	            return prev.filter((item) => item.id !== id)
	        })
	    }, [])

	    const clearList = () => {
	        setMyList((prev) => {
	            for (const item of prev) {
	                if (item?.autoManaged) dismissedAutoManagedItemIdsRef.current.add(item.id)
	            }
	            return []
	        })
	    }

    const handleRefreshCatalog = useCallback(async () => {
        setRefreshingCatalog(true)
        try {
            if (activeProvider === 'ncbi') {
                const res = await fetch(`${API_BASE}/api/remote/ncbi/refresh`, { method: 'POST' })
                const data = await res.json().catch(() => ({}))
                if (!res.ok) throw new Error(data?.detail || 'Failed to refresh RefSeq browse data')
                ncbiBrowseCacheRef.current = new Map()
                ncbiSearchCacheRef.current = new Map()
                await Promise.all([
                    fetchRefSeqGroups(),
                    fetchNcbiSearchResults(),
                ])
                setStatusMsg({ text: 'Refreshed RefSeq browse data.', isError: false })
                setTimeout(() => setStatusMsg(null), 4000)
                return
            }

            const res = await fetch(`${API_BASE}/api/remote/catalog/refresh`, { method: 'POST' })
            const data = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(data?.detail || 'Failed to refresh catalogue')
            setCatalogStatus(data)
            lastCatalogFingerprintRef.current = String(data?.current_catalog_fingerprint || lastCatalogFingerprintRef.current || '')
            await fetchRemoteCatalogData()
            if (typeof window !== 'undefined') {
                window.dispatchEvent(new Event(SELECTOR_REFRESH_EVENT))
            }
            setStatusMsg({ text: 'Checked Ensembl FTP catalogue for updates.', isError: false })
            setTimeout(() => setStatusMsg(null), 4000)
        } catch (e) {
            setStatusMsg({ text: `Catalogue refresh failed: ${e?.message || 'Unknown error'}`, isError: true })
            setTimeout(() => setStatusMsg(null), 5000)
        } finally {
            setRefreshingCatalog(false)
        }
    }, [activeProvider, fetchNcbiSearchResults, fetchRefSeqGroups, fetchRemoteCatalogData])

    const handleAcknowledgeCatalogChange = useCallback(async () => {
        const token = String(catalogStatus?.latest_change?.token || '')
        if (!token) return
        try {
            const res = await fetch(`${API_BASE}/api/remote/catalog/acknowledge`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token }),
            })
            if (!res.ok) throw new Error('Failed to dismiss catalogue notice')
            const data = await res.json()
            setCatalogStatus(data)
        } catch {
            // keep silent for acknowledgement
        }
    }, [catalogStatus])

    // ---------------------------------------------------------------------------
    // Retry a single failed file type for a specific item
    // ---------------------------------------------------------------------------
	    const handleRetry = useCallback(async (item, fileType) => {
	        if (!config?.output_dir) {
	            setStatusMsg({ text: 'Set an Output Directory in Configuration first.', isError: true })
	            setTimeout(() => setStatusMsg(null), 4000)
	            return
	        }
	        dismissedAutoManagedItemIdsRef.current.delete(item.id)
	        try {
            const filesRes = await fetch(buildRemoteFilesUrl(item, [fileType]))
            if (!filesRes.ok) throw new Error('Could not fetch file list')
            const files = await filesRes.json()
            const file = files.find(f => f.type === fileType)
            if (!file) throw new Error(`No ${fileType} file found for this assembly`)
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
                    taxid: Number(item.taxid) || 0,
                    ...datasetReleaseDownloadMetadata(file, item),
                }),
            })
            const data = await res.json().catch(() => ({}))
            if (!res.ok) {
                throw new Error(data?.detail || 'Failed to start retry')
            }
            if (data?.status === 'already_exists' || data?.status === 'completed') {
                fetchLocalAssemblies()
                setStatusMsg({ text: `${fileTypeLabel(fileType)} is already present locally for ${getAssemblyAccession(item)}.`, isError: false })
                setTimeout(() => setStatusMsg(null), 4000)
                return
            }
            setMyList((prev) => prev.map((entry) =>
                entry.id === item.id
                    ? {
                        ...entry,
                        autoManaged: true,
                        localTypes: undefined,
                        requestedTypes: [
                            ...new Set([
                                ...(Array.isArray(entry.requestedTypes) ? entry.requestedTypes : []),
                                fileType,
                            ]),
                        ],
                    }
                    : entry
            ))
            setStatusMsg({ text: `Retrying ${fileTypeLabel(fileType)} download for ${getAssemblyAccession(item)}…`, isError: false })
            setTimeout(() => setStatusMsg(null), 4000)
        } catch (e) {
            setStatusMsg({ text: `Retry failed: ${e?.message || 'Unknown error'}`, isError: true })
            setTimeout(() => setStatusMsg(null), 5000)
        }
    }, [buildRemoteFilesUrl, config?.output_dir, fetchLocalAssemblies])

    // ---------------------------------------------------------------------------
    // Download
    // ---------------------------------------------------------------------------
    const handleDownload = async (items, fileTypes) => {
        if (items.length === 1 && isDemoGenomeItem(items[0])) {
            await handleDemoGenomeInstall()
            return
        }
        if (!config?.output_dir) {
            setStatusMsg({ text: 'Set an Output Directory in Configuration first.', isError: true })
            setTimeout(() => setStatusMsg(null), 4000)
            return
        }
	        setDownloading(true)
	        let started = 0
	        let alreadyLocal = 0
	        let alreadyQueued = 0
	        const startedItemIds = new Set()
        const startedTypesByItem = new Map()
        const shouldAutoIncludeMetadata = fileTypes.includes('fasta') || fileTypes.includes('gff3')
        const effectiveTypes = shouldAutoIncludeMetadata
            ? [...new Set([...fileTypes, 'metadata'])]
            : [...fileTypes]
	        try {
	            for (const item of items) {
	                dismissedAutoManagedItemIdsRef.current.delete(item.id)
	            }
	            for (const item of items) {
                let startedForItem = false
                const filesRes = await fetch(buildRemoteFilesUrl(item, effectiveTypes))
                if (!filesRes.ok) continue
                const files = await filesRes.json()
                const queuedFiles = files.filter(f => effectiveTypes.includes(f.type))
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
	                            taxid: Number(item.taxid) || 0,
                                ...datasetReleaseDownloadMetadata(file, item),
	                        }),
                    })
                    const data = await res.json().catch(() => ({}))
                    if (!res.ok) {
                        continue
                    }
                    if (data?.status === 'started' || data?.status === 'pending' || data?.status === 'downloading') {
                        started++
                        startedForItem = true
                        if (!startedTypesByItem.has(item.id)) startedTypesByItem.set(item.id, new Set())
                        startedTypesByItem.get(item.id).add(file.type)
                    } else if (data?.status === 'already_exists' || data?.status === 'completed') {
                        alreadyLocal++
                    } else {
                        alreadyQueued++
                    }
                }
                if (startedForItem) startedItemIds.add(item.id)
            }
            if (startedItemIds.size > 0) {
                setMyList((prev) => prev.map((item) =>
                    startedItemIds.has(item.id)
                        ? {
                            ...item,
                            autoManaged: true,
                            localTypes: undefined,
                            requestedTypes: [
                                ...new Set([
                                    ...(Array.isArray(item.requestedTypes) ? item.requestedTypes : []),
                                    ...Array.from(startedTypesByItem.get(item.id) || []),
                                ]),
                            ],
                        }
                        : item
                ))
            }
            if (alreadyLocal > 0) {
                fetchLocalAssemblies()
            }
            const statusParts = []
            if (started > 0) statusParts.push(`Started ${started} file download${started !== 1 ? 's' : ''}`)
            if (alreadyQueued > 0) statusParts.push(`${alreadyQueued} already queued`)
            if (alreadyLocal > 0) statusParts.push(`${alreadyLocal} already present locally`)
            setStatusMsg({
                text: `${statusParts.length > 0 ? statusParts.join(' • ') : 'No new downloads were needed'}.`,
                isError: false,
            })
        } catch (e) {
            setStatusMsg({ text: `Error: ${e.message}`, isError: true })
        } finally {
            setDownloading(false)
            setTimeout(() => setStatusMsg(null), 5000)
        }
    }

    // ---------------------------------------------------------------------------
    // Styles
    // ---------------------------------------------------------------------------
    const latestCatalogChange = catalogStatus?.latest_change || null
    const latestCatalogChangeMessage = buildCatalogChangeMessage(latestCatalogChange)
    const showCatalogChangeBanner = Boolean(
        latestCatalogChange
        && latestCatalogChange.seen === false
        && latestCatalogChangeMessage
    )
    const catalogWarnings = Array.isArray(catalogStatus?.catalog_warnings)
        ? catalogStatus.catalog_warnings.filter((warning) => String(warning || '').trim())
        : []
    const catalogWarningMessage = catalogWarnings.length > 1
        ? `${catalogWarnings[0]} (${catalogWarnings.length - 1} more)`
        : (catalogWarnings[0] || '')
    // On first run the catalogue is downloaded in the background, so an empty species list
    // means "still arriving" rather than "nothing to show". Say which.
    const fetchingInitialCatalog = Boolean(catalogStatus?.initial_fetch_in_progress)
    const catalogUnavailable = catalogStatus?.catalog_available === false && !fetchingInitialCatalog
    const catalogLoadError = String(catalogStatus?.last_error || '').trim()
    const bg = isLight ? 'bg-gray-50' : 'bg-gray-900'
    const panelClass = `rounded-xl border overflow-hidden ${isLight ? 'bg-white border-gray-200' : 'bg-gray-800 border-gray-700'}`
    const thClass = `px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide border-b ${isLight ? 'text-gray-500 bg-gray-50 border-gray-200' : 'text-gray-400 bg-gray-750 border-gray-700'}`
    const borderClass = isLight ? 'border-gray-200' : 'border-gray-700'
    const canCaptureRasterScreenshot = typeof window !== 'undefined' &&
        typeof window.electronAPI?.captureHtmlSnapshot === 'function'
    const screenshotTarget = useMemo(() => {
        const node = screenshotRootNode
        if (!node) return null
        const allowedFormats = canCaptureRasterScreenshot ? ['svg', 'png', 'jpeg'] : ['svg']
        return {
            id: 'download-view',
            label: 'Download view',
            allowedFormats,
            defaultFormat: canCaptureRasterScreenshot ? 'png' : 'svg',
            getVisibleRect: () => node.getBoundingClientRect(),
            getScrollElement: () => node,
            buildDefaultFilename: () => buildDefaultScreenshotName('ens_download_page'),
            buildExportSnapshot: async () => {
                const { width, height } = measureScreenshotNode(node)
                return buildDomNodeScreenshotSnapshot(node, {
                    width,
                    height,
                    backgroundColor: isLight ? '#f9fafb' : '#111827',
                })
            },
        }
    }, [canCaptureRasterScreenshot, isLight, screenshotRootNode])

    const defaultScreenshotDir = useMemo(() => {
        const base = String(config?.output_dir || '').trim().replace(/\/+$/, '')
        return base ? `${base}/screenshots` : ''
    }, [config?.output_dir])

    useEffect(() => {
        onScreenshotAvailabilityChange?.('download', Boolean(screenshotTarget))
        return () => onScreenshotAvailabilityChange?.('download', false)
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
                    backgroundColor: snapshot.backgroundColor || (isLight ? '#f9fafb' : '#111827'),
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
        <div ref={setScreenshotRoot} className={`relative h-full flex flex-col ${bg} overflow-hidden`} data-screenshot-capture="view">
            {/* Header bar */}
            <div className={`px-6 py-3 border-b shrink-0 flex items-center gap-4 ${isLight ? 'bg-white border-gray-200' : 'bg-gray-800 border-gray-700'}`}>
                <div>
                    <h2 className={`font-semibold ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>
                        {activeProvider === 'ncbi' ? 'RefSeq Genomes — Data Browser' : 'Ensembl Data Browser'}
                    </h2>
                        <p className={`text-xs mt-0.5 ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                            {activeProvider === 'ncbi'
                                ? 'Browse RefSeq annotated assemblies by taxonomic group, or search by name or accession'
                                : 'Browse and download genomes, gene annotations, and homologies from the Ensembl FTP'}
                        </p>
                    </div>
                <div className="ml-auto flex items-center gap-3">
                    <button
                        type="button"
                        onClick={handleRefreshCatalog}
                        disabled={refreshingCatalog || catalogStatus?.refresh_in_progress}
                        className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${refreshingCatalog || catalogStatus?.refresh_in_progress
                            ? (isLight ? 'bg-gray-100 text-gray-400' : 'bg-gray-700 text-gray-500')
                            : (isLight ? 'bg-blue-600 text-white hover:bg-blue-700' : 'bg-blue-500 text-white hover:bg-blue-400')
                            }`}
                    >
                        {refreshingCatalog || catalogStatus?.refresh_in_progress ? 'Checking…' : 'Update'}
                    </button>
                    <div className={`flex items-center gap-1 rounded-xl border px-1 py-1 ${isLight ? 'border-gray-200 bg-gray-50' : 'border-gray-700 bg-gray-900/40'}`}>
                        {[
                            { id: 'ensembl', label: 'Ensembl' },
                            { id: 'ncbi', label: 'RefSeq' },
                        ].map((option) => {
                            const active = activeProvider === option.id
                            return (
                                <button
                                    key={option.id}
                                    type="button"
                                    onClick={() => {
                                        setActiveProvider(option.id)
                                        setExpandedKey(null)
                                        setStatusMsg(null)
                                    }}
                                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${active
                                        ? (isLight ? 'bg-blue-600 text-white' : 'bg-blue-500 text-white')
                                        : (isLight ? 'text-gray-600 hover:bg-white' : 'text-gray-300 hover:bg-gray-800')
                                        }`}
                                >
                                    {option.label}
                                </button>
                            )
                        })}
                    </div>
                </div>
                {!config?.output_dir && (
                    <div className={`flex items-center gap-2 text-xs px-3 py-1.5 rounded-lg border ${isLight ? 'bg-amber-50 border-amber-200 text-amber-700' : 'bg-amber-900/20 border-amber-700/50 text-amber-400'}`}>
                        ⚠ Set an Output Directory in Configuration before downloading
                    </div>
                )}
            </div>

            {/* Body: sidebar + main */}
            <div className="flex-1 min-h-0 flex overflow-hidden">

                {/* Left sidebar — group browser */}
                <div className={`w-52 shrink-0 border-r overflow-y-auto p-3 ${isLight ? 'bg-white border-gray-200' : 'bg-gray-800 border-gray-700'}`}>
                    {activeProvider === 'ensembl' ? (
                        <>
                            <div className={`text-xs font-bold uppercase tracking-widest mb-2 px-1 ${isLight ? 'text-gray-400' : 'text-gray-500'}`}>
                                Browse by group
                            </div>
                            {loading
                                ? <div className="px-1 text-sm opacity-40">Loading…</div>
                                : <GroupBrowser
                                    groups={sidebarGroups}
                                    totalAssemblies={totalAssemblies}
                                    activeGroup={activeGroup}
                                    activeSubGroup={activeSubGroup}
                                    onSelectGroup={g => { setActiveGroup(g); setExpandedKey(null) }}
                                    onSelectSubGroup={sg => { setActiveSubGroup(sg); setExpandedKey(null) }}
                                    isLight={isLight}
                                />
                            }
                        </>
                    ) : (
                        <>
                            <div className={`text-xs font-bold uppercase tracking-widest mb-2 px-1 ${isLight ? 'text-gray-400' : 'text-gray-500'}`}>
                                Browse by group
                            </div>
                            <RefSeqGroupBrowser
                                groups={refSeqGroups}
                                activeGroup={activeRefSeqGroup}
                                activeSubGroup={activeRefSeqSubGroup}
                                onSelectGroup={g => {
                                    setActiveRefSeqGroup(g)
                                    setActiveRefSeqSubGroup(null)
                                    setNcbiCurrentPageToken(null)
                                    setNcbiNextPageToken(null)
                                    setNcbiPageTokenHistory([])
                                    setExpandedKey(null)
                                }}
                                onSelectSubGroup={sg => {
                                    setActiveRefSeqSubGroup(sg)
                                    setNcbiCurrentPageToken(null)
                                    setNcbiNextPageToken(null)
                                    setNcbiPageTokenHistory([])
                                    setExpandedKey(null)
                                }}
                                isLight={isLight}
                                loading={refSeqGroupsLoading}
                            />
                        </>
                    )}
                </div>

                {/* Right: search + my list + species table */}
                <div className="flex-1 min-h-0 flex flex-col overflow-hidden">

                    {/* Search bar */}
                    <div className={`px-4 py-3 border-b shrink-0 flex items-center gap-3 ${isLight ? 'bg-white border-gray-200' : 'bg-gray-800 border-gray-700'}`}>
                        <div className={`flex items-center gap-2 flex-1 px-3 py-1.5 rounded-lg border ${isLight ? 'bg-gray-50 border-gray-300' : 'bg-gray-700 border-gray-600'}`}>
                            <span className="opacity-40"><IconSearch /></span>
                            <input
                                data-tour-id="download-search"
                                type="text"
                                placeholder={activeProvider === 'ncbi'
                                    ? 'Search NCBI species, assembly, or accession…'
                                    : 'Search species name, common name, or assembly accession…'}
                                value={search}
                                onChange={e => setSearch(e.target.value)}
                                className={`flex-1 bg-transparent outline-none text-sm ${isLight ? 'text-gray-900 placeholder-gray-400' : 'text-gray-100 placeholder-gray-500'}`}
                            />
                            {search && <button onClick={() => setSearch('')} className="opacity-40 hover:opacity-70 text-xs">✕</button>}
                        </div>
                        <span className={`text-xs whitespace-nowrap ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                            {activeProvider === 'ncbi' && ncbiLoading
                                ? 'Loading…'
                                : activeProvider === 'ncbi' && !search.trim() && activeRefSeqGroup === 'All genomes' && ncbiTotalCount != null
                                    ? `${ncbiTotalCount.toLocaleString()} genomes`
                                : activeProvider === 'ensembl' && activeGroup === 'Local genomes'
                                    ? `${filteredLocalAssemblies.length.toLocaleString()} local genomes`
                                : `${filteredSpecies.length.toLocaleString()} ${activeProvider === 'ncbi' ? 'results' : 'species'}`}
                        </span>
                    </div>

                    {activeProvider === 'ensembl' && fetchingInitialCatalog && (
                        <div className={`mx-4 mt-4 rounded-xl border px-4 py-3 flex items-start gap-3 ${isLight ? 'bg-blue-50 border-blue-200 text-blue-900' : 'bg-blue-900/20 border-blue-700/50 text-blue-100'}`}>
                            <svg
                                className="w-4 h-4 mt-0.5 shrink-0 animate-spin"
                                viewBox="0 0 24 24"
                                fill="none"
                                aria-hidden="true"
                            >
                                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
                                <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                            </svg>
                            <div className="min-w-0">
                                <div className="text-sm font-semibold">Fetching species catalogue…</div>
                                <div className={`text-xs mt-1 ${isLight ? 'text-blue-800/80' : 'text-blue-100/80'}`}>
                                    Downloading the list of available species from Ensembl. This happens once,
                                    on first run, and the list below fills in automatically when it finishes.
                                </div>
                            </div>
                        </div>
                    )}

                    {activeProvider === 'ensembl' && catalogUnavailable && (
                        <div className={`mx-4 mt-4 rounded-xl border px-4 py-3 flex items-start justify-between gap-4 ${isLight ? 'bg-amber-50 border-amber-200 text-amber-900' : 'bg-amber-900/20 border-amber-700/50 text-amber-100'}`}>
                            <div className="min-w-0">
                                <div className="text-sm font-semibold">No species catalogue available</div>
                                <div className={`text-xs mt-1 ${isLight ? 'text-amber-800/80' : 'text-amber-100/80'}`}>
                                    {catalogLoadError
                                        ? `The species list could not be downloaded from Ensembl: ${catalogLoadError}`
                                        : 'The species list could not be downloaded from Ensembl. Check your internet connection and try again.'}
                                    {' '}Local genomes are still available.
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={handleRefreshCatalog}
                                disabled={refreshingCatalog}
                                className={`px-3 py-1.5 rounded-lg text-xs font-semibold border whitespace-nowrap ${isLight ? 'border-amber-300 hover:bg-amber-100' : 'border-amber-500/40 hover:bg-amber-800/30'} ${refreshingCatalog ? 'opacity-50' : ''}`}
                            >
                                {refreshingCatalog ? 'Retrying…' : 'Retry'}
                            </button>
                        </div>
                    )}

                    {activeProvider === 'ensembl' && showCatalogChangeBanner && (
                        <div className={`mx-4 mt-4 rounded-xl border px-4 py-3 flex items-start justify-between gap-4 ${isLight ? 'bg-blue-50 border-blue-200 text-blue-900' : 'bg-blue-900/20 border-blue-700/50 text-blue-100'}`}>
                            <div className="min-w-0">
                                <div className="text-sm font-semibold">
                                    Catalogue updates found
                                </div>
                                <div className={`text-xs mt-1 ${isLight ? 'text-blue-800/80' : 'text-blue-100/80'}`}>
                                    {latestCatalogChangeMessage}
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={handleAcknowledgeCatalogChange}
                                className={`px-3 py-1.5 rounded-lg text-xs font-semibold border whitespace-nowrap ${isLight ? 'border-blue-200 hover:bg-blue-100' : 'border-blue-500/40 hover:bg-blue-800/30'}`}
                            >
                                Dismiss
                            </button>
                        </div>
                    )}

                    {activeProvider === 'ensembl' && catalogWarningMessage && (
                        <div className={`mx-4 mt-4 rounded-xl border px-4 py-3 ${isLight ? 'bg-amber-50 border-amber-200 text-amber-900' : 'bg-amber-900/20 border-amber-700/50 text-amber-100'}`}>
                            <div className="text-sm font-semibold">Catalogue warning</div>
                            <div className={`text-xs mt-1 ${isLight ? 'text-amber-800/80' : 'text-amber-100/80'}`}>
                                {catalogWarningMessage}
                            </div>
                        </div>
                    )}

                    {/* Content: local progress + species table */}
                    <div ref={speciesListScrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
                        {statusMsg && (
                            <div className={`rounded-lg border px-3 py-2 text-sm ${statusMsg.isError
                                ? (isLight ? 'bg-red-50 border-red-200 text-red-800' : 'bg-red-900/20 border-red-700/50 text-red-100')
                                : statusMsg.isWarning
                                    ? (isLight ? 'bg-amber-50 border-amber-200 text-amber-800' : 'bg-amber-900/20 border-amber-700/50 text-amber-100')
                                    : (isLight ? 'bg-green-50 border-green-200 text-green-800' : 'bg-green-900/20 border-green-700/50 text-green-100')
                                }`}>
                                {statusMsg.text}
                            </div>
                        )}

                        {activeProvider === 'ensembl' && activeGroup === 'Local genomes' ? (
                            <>
                                <DownloadTypeToolbar
                                    activeProvider={activeProvider}
                                    selectedTypes={activeDownloadTypes}
                                    onToggleType={(type) => {
                                        setActiveDownloadTypes((prev) => {
                                            const next = new Set(prev)
                                            next.has(type) ? next.delete(type) : next.add(type)
                                            return next
                                        })
                                    }}
                                    isLight={isLight}
                                />
                                <LocalGenomesList
                                    items={filteredLocalAssemblies}
                                    activeItems={filteredActiveLocalItems}
                                    selectedTypes={activeDownloadTypes}
                                    tasksByItemKey={tasksByItemKey}
                                    onDownload={handleRowDownload}
                                    onDownloadFiles={handleDownloadFiles}
                                    onCancelFiles={handleCancelDownloadFiles}
                                    onDeleteFile={handleDeleteLocalFile}
                                    onDeleteLocalGenome={handleDeleteLocalGenome}
                                    onDeleteAllLocalGenomes={handleDeleteAllLocalGenomes}
                                    deletingLocalGenomes={deletingLocalGenomes}
                                    downloading={downloading}
                                    isLight={isLight}
                                />
                            </>
                        ) : (
                        <div className={`${panelClass} flex flex-col`}>
                            {/* Collapsible header */}
                            <PanelHeader
                                title="Species Browser"
                                count={activeProvider === 'ncbi' && ncbiTotalCount != null ? ncbiTotalCount : filteredSpecies.length}
                                countLabel={activeProvider === 'ncbi' && ncbiTotalCount != null
                                    ? `${filteredSpecies.length.toLocaleString()} shown / ${ncbiTotalCount.toLocaleString()} total`
                                    : filteredSpecies.length.toLocaleString()}
                                collapsed={speciesCollapsed}
                                onToggle={() => setSpeciesCollapsed(p => !p)}
                                isLight={isLight}
                            />

                            {!speciesCollapsed && (
                                <>
                                    <DownloadTypeToolbar
                                        activeProvider={activeProvider}
                                        selectedTypes={activeDownloadTypes}
                                        onToggleType={(type) => {
                                            setActiveDownloadTypes((prev) => {
                                                const next = new Set(prev)
                                                next.has(type) ? next.delete(type) : next.add(type)
                                                return next
                                            })
                                        }}
                                        isLight={isLight}
                                    />

                                    {/* Column headers */}
                                    <div className={`grid shrink-0 border-b ${borderClass}`}
                                        style={{ gridTemplateColumns: 'minmax(0, 2fr) 155px minmax(0, 1fr) 140px 92px' }}>
                                        <div className={thClass}>Species</div>
                                        <div className={thClass}>Accession</div>
                                        <div className={thClass}>Assembly Name</div>
                                        <div className={thClass}>Source</div>
                                        <div className={thClass}></div>
                                    </div>

                                    {/* Scrollable rows */}
                                    {activeProvider === 'ensembl' && loading ? (
                                        <div className="h-40 flex items-center justify-center gap-2 opacity-40 text-sm">
                                            <div className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin flex-shrink-0" />
                                            Loading Ensembl genomes…
                                        </div>
                                    ) : activeProvider === 'ncbi' && ncbiLoading ? (
                                        <div className="h-40 flex items-center justify-center gap-2 opacity-40 text-sm">
                                            <div className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin flex-shrink-0" />
                                            Loading RefSeq genomes…
                                        </div>
                                    ) : pageSpecies.length === 0 ? (
                                        <div className="h-40 flex items-center justify-center opacity-40 text-sm">No genomes found</div>
                                    ) : (
                                        <div data-tour-id="download-species-list">
                                            {pageSpecies.map(species => (
                                                <SpeciesRow
                                                    key={species.key}
                                                    species={species}
                                                    expanded={expandedKey === species.key}
                                                    onToggleExpand={key => setExpandedKey(prev => prev === key ? null : key)}
                                                    onDownload={handleRowDownload}
                                                    onDownloadAll={handleDownloadAllAssemblies}
                                                    onDownloadFiles={handleDownloadFiles}
                                                    onCancelFiles={handleCancelDownloadFiles}
                                                    onDeleteFile={handleDeleteLocalFile}
                                                    selectedTypes={activeDownloadTypes}
                                                    localTypeByKey={localTypeByKey}
                                                    localFileInfoByKey={localFileInfoByKey}
                                                    tasksByItemKey={tasksByItemKey}
                                                    downloading={downloading}
                                                    demoProgress={demoProgress}
                                                    isLight={isLight}
                                                />
                                            ))}
                                        </div>
                                    )}

                                    {activeProvider === 'ncbi' && !search.trim() && (ncbiPageTokenHistory.length > 0 || ncbiNextPageToken) && (
                                        <div className={`px-4 py-3 border-t shrink-0 flex items-center justify-between ${isLight ? 'bg-gray-50 border-gray-200' : 'bg-gray-750 border-gray-700'}`}>
                                            <button
                                                onClick={() => {
                                                    const history = [...ncbiPageTokenHistory]
                                                    const prevToken = history.pop() ?? null
                                                    setNcbiPageTokenHistory(history)
                                                    fetchNcbiSearchResults(prevToken)
                                                }}
                                                disabled={ncbiPageTokenHistory.length === 0}
                                                className={`px-3 py-1 text-xs rounded border transition-colors ${ncbiPageTokenHistory.length === 0
                                                    ? (isLight ? 'text-gray-300 border-gray-200' : 'text-gray-600 border-gray-700')
                                                    : (isLight ? 'text-gray-700 border-gray-300 hover:bg-gray-100' : 'text-gray-300 border-gray-600 hover:bg-gray-700')}`}
                                            >
                                                ← Previous
                                            </button>
                                            <span className={`text-xs ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                                Page {ncbiPageTokenHistory.length + 1}
                                                {ncbiTotalCount != null && (
                                                    <span className="ml-2 opacity-60">
                                                        ({ncbiSpecies.length.toLocaleString()} shown of {ncbiTotalCount.toLocaleString()})
                                                    </span>
                                                )}
                                            </span>
                                            <button
                                                onClick={() => {
                                                    if (!ncbiNextPageToken) return
                                                    setNcbiPageTokenHistory(prev => [...prev, ncbiCurrentPageToken ?? null])
                                                    fetchNcbiSearchResults(ncbiNextPageToken)
                                                }}
                                                disabled={!ncbiNextPageToken}
                                                className={`px-3 py-1 text-xs rounded border transition-colors ${!ncbiNextPageToken
                                                    ? (isLight ? 'text-gray-300 border-gray-200' : 'text-gray-600 border-gray-700')
                                                    : (isLight ? 'text-gray-700 border-gray-300 hover:bg-gray-100' : 'text-gray-300 border-gray-600 hover:bg-gray-700')}`}
                                            >
                                                Next →
                                            </button>
                                        </div>
                                    )}

                                    {totalPages > 1 && (
                                        <div className={`px-4 py-3 border-t shrink-0 flex items-center justify-between ${isLight ? 'bg-gray-50 border-gray-200' : 'bg-gray-750 border-gray-700'}`}>
                                            <button
                                                onClick={() => setPage(p => Math.max(1, p - 1))}
                                                disabled={page === 1}
                                                className={`px-3 py-1 text-xs rounded border transition-colors ${page === 1
                                                    ? (isLight ? 'text-gray-300 border-gray-200' : 'text-gray-600 border-gray-700')
                                                    : (isLight ? 'text-gray-700 border-gray-300 hover:bg-gray-100' : 'text-gray-300 border-gray-600 hover:bg-gray-700')}`}
                                            >
                                                ← Previous
                                            </button>
                                            <span className={`text-xs ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                                Page {page} of {totalPages}
                                                <span className="ml-2 opacity-60">
                                                    ({((page - 1) * PAGE_SIZE) + 1}–{Math.min(page * PAGE_SIZE, filteredSpecies.length)} of {filteredSpecies.length.toLocaleString()})
                                                </span>
                                            </span>
                                            <button
                                                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                                                disabled={page === totalPages}
                                                className={`px-3 py-1 text-xs rounded border transition-colors ${page === totalPages
                                                    ? (isLight ? 'text-gray-300 border-gray-200' : 'text-gray-600 border-gray-700')
                                                    : (isLight ? 'text-gray-700 border-gray-300 hover:bg-gray-100' : 'text-gray-300 border-gray-600 hover:bg-gray-700')}`}
                                            >
                                                Next →
                                            </button>
                                        </div>
                                    )}
                                </>
                            )}
                        </div>
                        )}
                    </div>
                </div>
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

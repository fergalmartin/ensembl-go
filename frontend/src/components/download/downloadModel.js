// The Download view's model: catalogue groups and featured organisms, download
// file types and labels, normalising remote species and assemblies, and matching
// availability files to download tasks and local files. Pure functions.
import { DOWNLOAD_FILE_DEFS, fileTypeLabel } from '../../utils/genomeFileTypes.js'
import { getAssemblyAccession, getAssemblyGenomeKey, normalizeGenomeProvider, normalizeGenomeSourceDatabase } from '../../utils/genomeIdentity.js'

export const PAGE_SIZE = 50

// Groups that form the "Vertebrates" super-category in the sidebar
export const VERTEBRATE_GROUPS = new Set(['Mammals', 'Fish', 'Birds', 'Reptiles', 'Amphibians'])

export const REFSEQ_INVERTEBRATE_GROUPS = new Set(['Insects', 'Nematodes'])

export const REFSEQ_MICROBE_GROUPS = new Set(['Bacteria', 'Archaea'])

export const REFSEQ_FEATURED_ACCESSIONS = new Set([
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
export const MODEL_ORGANISMS = [
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

export const taskStatusPriority = (task) => {
    const status = String(task?.status || '')
    if (status === 'downloading') return 4
    if (status === 'pending') return 3
    if (status === 'completed') return 2
    if (status === 'failed') return 1
    return 0
}

export const pickPreferredTask = (tasks) => {
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

export const formatCatalogTimestamp = (value) => {
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

export const buildCatalogChangeMessage = (latestChange) => {
    if (!latestChange) return ''
    const parts = []
    const addedCount = Number(latestChange.added_count || 0)
    const retiredCount = Number(latestChange.retired_count || 0)
    if (addedCount > 0) parts.push(`${addedCount} new genome${addedCount === 1 ? '' : 's'} added`)
    if (retiredCount > 0) parts.push(`${retiredCount} genome${retiredCount === 1 ? '' : 's'} retired upstream`)
    return parts.join(' • ')
}

export const formatSpeciesNameFromKey = (value) => String(value || '').trim().replace(/_/g, ' ')

export const normalizeRemoteAssembly = (assembly, provider) => {
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

export const normalizeRemoteSpecies = (species, fallbackProvider) => {
    const provider = normalizeGenomeProvider(species?.provider || fallbackProvider)
    return {
        ...species,
        provider,
        assemblies: Array.isArray(species?.assemblies)
            ? species.assemblies.map((assembly) => normalizeRemoteAssembly(assembly, provider))
            : [],
    }
}

export const matchesModelOrganism = (speciesKey, assembly) => {
    const accession = getAssemblyAccession(assembly)
    return MODEL_ORGANISMS.some((item) => item.key === speciesKey && item.gca === accession)
}

export const NCBI_EXAMPLE_ORGANISMS = [
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

export const buildNcbiExampleSpecies = () => {
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

export const NCBI_EXAMPLE_SPECIES = buildNcbiExampleSpecies()

// ---------------------------------------------------------------------------
// File type status badge — shows download progress inline
// ---------------------------------------------------------------------------
export const ENSEMBL_DOWNLOAD_FILE_TYPES = ['fasta', 'gff3', 'homology', 'cdna', 'protein', 'xref']

export const REFSEQ_DOWNLOAD_FILE_TYPES = ['fasta', 'gff3']

export const DEFAULT_DOWNLOAD_FILE_TYPES = ['fasta', 'gff3']

export const DATASET_DOWNLOAD_TYPES = new Set(['gff3', 'homology', 'cdna', 'protein', 'xref', 'gff3_index', 'gtf_index', 'cdna_index', 'protein_index', 'xref_index', 'gtf', 'embl', 'alignment', 'other_annotation'])

export const ASSEMBLY_DOWNLOAD_TYPES = new Set(['fasta', 'metadata'])

export const selectedDownloadTypeList = (selectedTypes) => (
    Array.from(selectedTypes || []).filter((type) => type && type !== 'metadata')
)

export const withImplicitMetadataTypes = (types) => {
    const selected = Array.from(types || []).map((type) => String(type || '').trim()).filter(Boolean)
    if (selected.includes('fasta') || selected.includes('gff3')) selected.push('metadata')
    return [...new Set(selected)]
}

export const missingSelectedDownloadTypes = (selectedTypes, localTypes) => {
    const local = new Set((Array.isArray(localTypes) ? localTypes : []).map((type) => String(type || '').trim()).filter(Boolean))
    return selectedDownloadTypeList(selectedTypes).filter((type) => !local.has(type))
}

export const fileDisplayParts = (file) => {
    const def = DOWNLOAD_FILE_DEFS[file?.type] || {}
    return {
        category: def.category || 'File',
        subtype: def.subtype || fileTypeLabel(file?.type),
        filename: String(file?.filename || ''),
    }
}

export const PRIMARY_DATASET_LABELS = {
    gff3: 'Genes',
    homology: 'Homologies',
    cdna: 'Transcripts',
    protein: 'Proteins',
    xref: 'Xrefs',
}

export const primaryDatasetTypeOrder = ['gff3', 'homology', 'cdna', 'protein', 'xref']

export const selectAssemblyDisplayFiles = (files) => {
    const fastaFiles = (Array.isArray(files) ? files : []).filter((file) => file?.type === 'fasta')
    if (fastaFiles.length === 0) return []
    const selected = fastaFiles.find((file) => file?.selected_by_default)
    const softmasked = fastaFiles.find((file) => /softmask/i.test(`${file?.filename || ''} ${file?.url || ''}`))
    return [selected || softmasked || fastaFiles[0]]
}

export const selectPrimaryDatasetFiles = (files) => {
    const releaseFiles = Array.isArray(files) ? files : []
    return primaryDatasetTypeOrder
        .map((type) => {
            const candidates = releaseFiles.filter((file) => file?.type === type)
            return candidates.find((file) => file?.selected_by_default) || candidates[0] || null
        })
        .filter(Boolean)
}

export const fileSubjectLabel = (file) => {
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

export const fileIndexSubjectLabel = (file) => {
    const type = String(file?.type || '')
    const parentType = String(file?.parent_type || '')
    if (type === 'protein_index' || parentType === 'protein') return 'Protein'
    if (type === 'cdna_index' || parentType === 'cdna') return 'Transcript'
    if (type === 'xref_index' || parentType === 'xref') return 'Xref'
    if (type === 'homology_index' || parentType === 'homology') return 'Homology'
    if (type === 'gff3_index' || type === 'gtf_index' || ['gff3', 'gtf'].includes(parentType)) return 'Genes'
    return fileSubjectLabel(file)
}

export const alignmentFileLabel = (file) => {
    const species = String(file?.other_species_name || '').trim() || 'Other species'
    const accession = String(file?.other_species_gca || file?.other_species_gcf || file?.other_accession || '').trim()
    const alignmentType = String(file?.alignment_type || '').trim()
    return [species, accession, alignmentType].filter(Boolean).join(' - ')
}

export const compactFileLabel = (file, primary = false) => {
    if (primary) return PRIMARY_DATASET_LABELS[file?.type] || fileSubjectLabel(file)
    if (file?.type === 'alignment') return alignmentFileLabel(file)
    if (file?.is_index || String(file?.type || '').endsWith('_index')) {
        const subject = fileIndexSubjectLabel(file)
        return `${subject} Index`
    }
    return fileSubjectLabel(file)
}

export const sortFilesByCompactLabel = (files) => {
    return [...(Array.isArray(files) ? files : [])].sort((a, b) => {
        const labelCompare = compactFileLabel(a).localeCompare(compactFileLabel(b), undefined, { numeric: true, sensitivity: 'base' })
        if (labelCompare !== 0) return labelCompare
        return String(a?.filename || '').localeCompare(String(b?.filename || ''), undefined, { numeric: true, sensitivity: 'base' })
    })
}

export const withRequiredMetadataFiles = (files, allFiles) => {
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

export const sortAvailabilityReleases = (releases) => {
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

// ---------------------------------------------------------------------------
// Assembly list (expanded inline for multi-assembly species)
// ---------------------------------------------------------------------------
export const availabilityFileId = (file) => [
    file?.scope || (DATASET_DOWNLOAD_TYPES.has(file?.type) ? 'dataset' : 'assembly'),
    file?.dataset_release_key || '',
    file?.type || '',
    file?.filename || '',
].join('::')

export const gcaPrefixedDownloadFilename = (file, item) => {
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

export const fileTaskMatches = (file, task, item) => {
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

export const taskForAvailabilityFile = (file, itemTasks, item) => {
    const matches = (Array.isArray(itemTasks) ? itemTasks : []).filter((task) => fileTaskMatches(file, task, item))
    return pickPreferredTask(matches) || null
}

export const basenameFromPath = (value) => String(value || '').split(/[\\/]/).pop() || ''

export const localPathMatchesFile = (path, file, item) => {
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

export const localFilePathForAvailabilityFile = (file, item, localFileInfo) => {
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

export const itemFromSpeciesAssembly = (species, asm) => {
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

export const chooseFilesForTypes = (availability, selectedTypes) => {
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

// ---------------------------------------------------------------------------
// My Download List
// ---------------------------------------------------------------------------

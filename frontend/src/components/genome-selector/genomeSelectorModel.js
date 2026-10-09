// The Genome Selector's model: accepted file extensions, paging and removal limits,
// genome identity within the selector, playlist normalisation, search matching and
// playlist labels. Pure functions.
import { basenameFromPath, stripGffSuffix } from '../../utils/customGenomeImport.js'
import { genomeKeysMatch, getAssemblyAccession, getGenomeKey, normalizeGenomeProvider, normalizeGenomeRecord, normalizeGenomeSourceDatabase } from '../../utils/genomeIdentity.js'
import { formatSpeciesNameFromKey } from '../../utils/playlistGenomes.js'

export const FASTA_EXTENSIONS = ['.fa', '.fna', '.fasta', '.fa.gz', '.fna.gz', '.fasta.gz', '.fa.bgz', '.fna.bgz', '.fasta.bgz']

// GFF3 loads directly; GFF and GTF are accepted too but must be converted into
// canonical GFF3 on import, which the backend enforces.
export const GFF3_EXTENSIONS = [
    '.gff3', '.gff3.gz', '.gff3.bgz',
    '.gff', '.gff.gz', '.gff.bgz',
    '.gtf', '.gtf.gz', '.gtf.bgz',
]

export const CONVERSION_REQUIRED_EXTENSIONS = ['.gtf', '.gtf.gz', '.gtf.bgz', '.gff2', '.gff2.gz']

export const HOMOLOGY_EXTENSIONS = ['.tsv', '.tsv.gz']

export const LOCAL_PAGE_SIZE = 10

// Selecting this many genomes at once is worth a confirmation: it changes what
// the whole app is working with.
export const BULK_SELECT_CONFIRM_THRESHOLD = 50

// Genomes per remove-data call, so a long run reports progress as it goes.
export const REMOVAL_CHUNK_SIZE = 8

export const PLAYLIST_ALL_ID = '__all__'

export const todayIsoDate = () => new Date().toISOString().slice(0, 10)

export const defaultCustomAnnotationLabel = () => `custom ${todayIsoDate()}`

// ---------------------------------------------------------------------------
// Expanded per-genome file editor panel
// ---------------------------------------------------------------------------
export const FILE_EDIT_EXTENSIONS = {
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

export const DEFAULT_BUNDLE_FILENAME = 'ensembl-go-genomes.json'

// Strips any annotation extension, so a GTF does not derive an index named
// `<name>.gtf.gz.gff3.index.db`.

export const manualIndexFilename = (genomeLabel = '', assemblyLabel = '', annotationPath = '') => {
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

export const itemKey = (item) => {
    return getGenomeKey(item)
}

export const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key)

export const normalizePlaylistGenome = (item) => {
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

export const normalizeGenomePlaylists = (playlists) => {
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

export const matchesGenomeSearch = (item, searchQuery) => {
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

export const formatPlaylistGenomeLabel = (item) => {
    const species = String(item?.display_name || item?.scientific_name || '').trim() || formatSpeciesNameFromKey(item?.species_key || '')
    const assembly = String(item?.assembly_name || item?.assembly || '').trim()
    return assembly ? `${species} (${assembly})` : species
}

export const canDownloadPlaylistGenome = (item) => {
    if (!item || item.is_manual) return false
    return Boolean(item.species_key && getAssemblyAccession(item) && normalizeGenomeProvider(item))
}

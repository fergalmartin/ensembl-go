// Portable genome bundles.
//
// A bundle describes a set of genomes — downloaded, manually added, or
// previously imported — with enough metadata and enough file paths to rebuild
// the Genome Selector row exactly, provided the files are already on disk.
//
// This module owns the two directions:
//   * export — turn selector records into the document the backend writes
//   * import — turn the backend's parse result into the review matrix model
//
// Playlists are deliberately not the transport: a playlist entry stores identity
// only, so a member that is not present locally cannot be recovered from it. The
// bundle is what carries paths; playlists remain the way sets are *named*, and
// exporting the current selection is how a playlist becomes a bundle.

import {
    BUNDLE_REQUIRED_FILE_TYPE,
    canonicalBundleFiles,
    orderBundleFileTypes,
} from './genomeFileTypes.js'

const text = (value) => String(value || '').trim()

const DATASET_RELEASE_FIELDS = ['key', 'source', 'date', 'label', 'short_label']

// Identity carried verbatim between a selector record and a bundle entry.
const IDENTITY_FIELDS = [
    'species_key',
    'common_name',
    'display_name',
    'display_name_reason',
    'assembly_name',
    'provider',
    'source_database',
]

export const bundleGenomeLabel = (genome) => {
    const species = text(
        genome?.display_name
        || genome?.scientific_name
        || genome?.species
        || genome?.species_key,
    ) || 'Unnamed species'
    const assembly = text(genome?.assembly_name || genome?.assembly)
    return assembly ? `${species} (${assembly})` : species
}

// A genome registered from local files still needs to say where it came from.
// `provider` is the honest answer: 'manual' means someone typed the paths in,
// anything else means the bundle declared a real source.
export const registrationBadgeLabel = (genome) => {
    if (!genome?.is_manual) return ''
    return text(genome?.provider).toLowerCase() === 'manual' ? 'Manual' : 'From file'
}

export const registrationBadgeTooltip = (genome) => {
    const source = text(genome?.source_database)
    if (text(genome?.provider).toLowerCase() === 'manual') {
        return 'Added by hand from local files'
    }
    return source
        ? `Registered from local files (${source})`
        : 'Registered from local files'
}

const datasetReleaseFromRecord = (genome) => {
    const release = {
        key: text(genome?.dataset_release_key),
        source: text(genome?.dataset_release_source),
        date: text(genome?.dataset_release_date),
        label: text(genome?.dataset_release_label),
        short_label: text(genome?.dataset_release_short_label),
    }
    return Object.values(release).some(Boolean) ? release : null
}

const normalizeAccessionList = (value) => {
    const result = []
    const seen = new Set()
    for (const item of Array.isArray(value) ? value : []) {
        const accession = text(item).toUpperCase()
        if (!accession || seen.has(accession)) continue
        seen.add(accession)
        result.push(accession)
    }
    return result
}

export const normalizeBundlePlaylistNames = (names) => {
    const normalized = []
    const seen = new Set()
    for (const rawName of Array.isArray(names) ? names : []) {
        const name = text(rawName).replace(/\s+/g, ' ')
        const key = name.toLocaleLowerCase()
        if (!name || seen.has(key)) continue
        seen.add(key)
        normalized.push(name)
    }
    return normalized
}

/**
 * Turn one selector record into a bundle entry.
 *
 * `files` is passed separately because the caller resolves it — a downloaded
 * genome's paths come from the live local-assembly scan and may be overridden by
 * `config.genome_file_overrides`, neither of which lives on the record itself.
 */
export const portableGenomeEntry = (genome, { files, playlists = [] } = {}) => {
    const record = {
        species: text(genome?.scientific_name || genome?.species),
        assembly: text(genome?.assembly || genome?.assembly_name),
        accession: text(genome?.gca || genome?.accession),
        files: canonicalBundleFiles(files || genome?.files),
    }
    for (const field of IDENTITY_FIELDS) {
        const value = text(genome?.[field])
        if (value) record[field] = value
    }
    const equivalent = normalizeAccessionList(genome?.equivalent_accessions)
    if (equivalent.length) record.equivalent_accessions = equivalent
    const release = datasetReleaseFromRecord(genome)
    if (release) record.dataset_release = release
    const names = normalizeBundlePlaylistNames(playlists)
    if (names.length) record.playlists = names
    return record
}

/**
 * Build the `{ genomes, playlists }` payload for POST /api/custom/genome-config/save.
 *
 * Genomes that cannot be described portably — no sequence file — are reported as
 * `skipped` rather than dropped silently, so the caller can name them.
 */
export const buildGenomeBundle = (entries, { playlists = [] } = {}) => {
    const genomes = []
    const skipped = []
    for (const entry of Array.isArray(entries) ? entries : []) {
        const record = portableGenomeEntry(entry?.genome, {
            files: entry?.files,
            playlists: entry?.playlists,
        })
        const label = bundleGenomeLabel(entry?.genome)
        if (!record.species || !record.assembly) {
            skipped.push({ label, reason: 'Missing species or assembly name' })
            continue
        }
        if (!record.files[BUNDLE_REQUIRED_FILE_TYPE]) {
            skipped.push({ label, reason: 'No genome FASTA is available locally' })
            continue
        }
        genomes.push(record)
    }

    // Only describe playlists that something in the export actually belongs to.
    const referenced = new Set()
    for (const record of genomes) {
        for (const name of record.playlists || []) referenced.add(name.toLocaleLowerCase())
    }
    const playlistMetadata = []
    const seen = new Set()
    for (const playlist of Array.isArray(playlists) ? playlists : []) {
        const name = text(playlist?.name).replace(/\s+/g, ' ')
        const key = name.toLocaleLowerCase()
        if (!name || seen.has(key) || !referenced.has(key)) continue
        seen.add(key)
        const description = text(playlist?.description)
        playlistMetadata.push(description ? { name, description } : { name })
    }

    return { genomes, playlists: playlistMetadata, skipped }
}

// ---------------------------------------------------------------------------
// Import side — the review matrix model
// ---------------------------------------------------------------------------

/** Cell states in the review matrix. */
export const BUNDLE_CELL_PRESENT = 'present'
export const BUNDLE_CELL_MISSING = 'missing'

const firstErrorMessage = (diagnostics) =>
    (Array.isArray(diagnostics) ? diagnostics : [])
        .find((item) => item?.severity === 'error')?.message || ''

const warningMessages = (diagnostics) =>
    (Array.isArray(diagnostics) ? diagnostics : [])
        .filter((item) => item?.severity === 'warning')
        .map((item) => String(item?.message || ''))
        .filter(Boolean)

/**
 * Turn a `POST /api/custom/genome-config/read` response into the matrix model.
 *
 * Columns are the union of file types the *document* mentions — present or not —
 * so a file listed for one genome still gets a column, and its absence elsewhere
 * reads as a gap rather than being invisible.
 */
export const bundlePreviewModel = (parseResult) => {
    const entries = Array.isArray(parseResult?.entries) ? parseResult.entries : []
    const mentioned = new Set()
    const rows = []

    for (const entry of entries) {
        const genome = entry?.genome || null
        const files = genome?.files || {}
        const missing = Array.isArray(entry?.missing_files) ? entry.missing_files : []
        const cells = {}

        for (const [fileType, path] of Object.entries(files)) {
            if (!text(path)) continue
            cells[fileType] = { state: BUNDLE_CELL_PRESENT, path: text(path) }
            mentioned.add(fileType)
        }
        for (const item of missing) {
            const fileType = String(item?.field || '').replace(/^files\./, '')
            if (!fileType) continue
            cells[fileType] = { state: BUNDLE_CELL_MISSING, path: text(item?.path) }
            mentioned.add(fileType)
        }

        const error = firstErrorMessage(entry?.diagnostics)
        rows.push({
            index: Number(entry?.index) || rows.length,
            label: bundleGenomeLabel(genome),
            accession: text(genome?.accession),
            sourceDatabase: text(genome?.source_database)
                || (text(genome?.provider).toLowerCase() === 'manual' ? 'Manual' : text(genome?.provider)),
            releaseLabel: text(genome?.dataset_release?.short_label || genome?.dataset_release?.label),
            playlists: Array.isArray(genome?.playlists) ? genome.playlists : [],
            valid: Boolean(entry?.valid),
            error,
            warnings: warningMessages(entry?.diagnostics),
            missingFiles: missing.map((item) => ({
                fileType: String(item?.field || '').replace(/^files\./, ''),
                path: text(item?.path),
            })),
            cells,
        })
    }

    const columns = orderBundleFileTypes(mentioned)
    const importable = rows.filter((row) => row.valid).map((row) => row.index)
    return {
        path: text(parseResult?.path),
        format: text(parseResult?.format),
        version: parseResult?.version,
        playlists: Array.isArray(parseResult?.playlists) ? parseResult.playlists : [],
        columns,
        rows,
        importableIndexes: importable,
        totalCount: rows.length,
        validCount: importable.length,
    }
}

/**
 * Collect every missing file across a parse result, labelled by genome, for the
 * post-import summary. A direct import skips the review matrix, so this is the
 * only place the user sees which paths did not resolve.
 */
export const bundleMissingFileReport = (parseResult, { indexes = null } = {}) => {
    const wanted = indexes ? new Set(indexes) : null
    const report = []
    for (const entry of Array.isArray(parseResult?.entries) ? parseResult.entries : []) {
        if (wanted && !wanted.has(entry?.index)) continue
        for (const item of Array.isArray(entry?.missing_files) ? entry.missing_files : []) {
            report.push({
                label: bundleGenomeLabel(entry?.genome),
                fileType: String(item?.field || '').replace(/^files\./, ''),
                path: text(item?.path),
            })
        }
    }
    return report
}

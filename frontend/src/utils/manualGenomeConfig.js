const normalizedLabel = (value) =>
    String(value || '')
        .trim()
        .toLocaleLowerCase()
        .replace(/\s+/g, ' ')

const genomeAccession = (genome) =>
    String(
        genome?.accession
        || genome?.gca
        || genome?.assembly_accession
        || '',
    ).trim().toUpperCase()

const genomeSpeciesLabel = (genome) =>
    genome?.species
    || genome?.scientific_name
    || genome?.display_name
    || genome?.species_key
    || ''

const genomeAssemblyLabel = (genome) =>
    genome?.assembly_name
    || genome?.assembly
    || ''

export const manualGenomeLabel = (genome) => {
    const species = String(genomeSpeciesLabel(genome) || '').trim() || 'Unnamed species'
    const assembly = String(genomeAssemblyLabel(genome) || '').trim()
    return assembly ? `${species} (${assembly})` : species
}

const genomeReleaseKey = (genome) =>
    String(genome?.dataset_release_key || genome?.dataset_release?.key || '').trim()

// Two dataset releases of one assembly are distinct genomes in the selector —
// they carry different selection keys and appear as separate rows — so a bundle
// listing both must not collapse them into one.
const releasesConflict = (left, right) => {
    const leftRelease = genomeReleaseKey(left)
    const rightRelease = genomeReleaseKey(right)
    return Boolean(leftRelease && rightRelease && leftRelease !== rightRelease)
}

export const manualGenomesAreDuplicates = (left, right) => {
    if (releasesConflict(left, right)) return false
    const leftAccession = genomeAccession(left)
    const rightAccession = genomeAccession(right)
    if (leftAccession && rightAccession) return leftAccession === rightAccession
    return (
        normalizedLabel(genomeSpeciesLabel(left)) === normalizedLabel(genomeSpeciesLabel(right))
        && normalizedLabel(genomeAssemblyLabel(left)) === normalizedLabel(genomeAssemblyLabel(right))
    )
}

export const findDuplicateManualGenome = (genome, candidates) =>
    (Array.isArray(candidates) ? candidates : []).find(
        (candidate) => manualGenomesAreDuplicates(genome, candidate),
    ) || null

export const normalizeManualPlaylistNames = (names) => {
    const normalized = []
    const seen = new Set()
    for (const rawName of Array.isArray(names) ? names : []) {
        const name = String(rawName || '').trim().replace(/\s+/g, ' ')
        const key = normalizedLabel(name)
        if (!name || seen.has(key)) continue
        seen.add(key)
        normalized.push(name)
    }
    return normalized
}

export const mergeManualGenomePlaylistMemberships = (
    playlists,
    assignments,
    {
        createPlaylistId,
        snapshotGenome,
        genomesMatch,
    },
) => {
    const next = (Array.isArray(playlists) ? playlists : []).map((playlist) => ({
        ...playlist,
        genomes: [...(Array.isArray(playlist?.genomes) ? playlist.genomes : [])],
    }))

    for (const assignment of Array.isArray(assignments) ? assignments : []) {
        const snapshot = snapshotGenome?.(assignment?.genome)
        if (!snapshot) continue
        for (const name of normalizeManualPlaylistNames(assignment?.playlists)) {
            const nameKey = normalizedLabel(name)
            let playlistIndex = next.findIndex(
                (playlist) => normalizedLabel(playlist?.name) === nameKey,
            )
            if (playlistIndex < 0) {
                next.push({
                    id: createPlaylistId(),
                    name,
                    description: 'Created from a manual genome configuration.',
                    genomes: [],
                    system: false,
                })
                playlistIndex = next.length - 1
            }
            const playlist = next[playlistIndex]
            if (playlist.genomes.some((member) => genomesMatch(member, snapshot))) continue
            next[playlistIndex] = {
                ...playlist,
                genomes: [
                    ...playlist.genomes,
                    {
                        ...snapshot,
                        active_by_default: playlist.genomes.length === 0,
                    },
                ],
            }
        }
    }
    return next
}

export const manualProgressText = (operation) => {
    const base = String(operation?.message || '').trim()
    const counters = operation?.counters || {}
    const stage = String(operation?.stage || '')
    const priority = stage === 'building_gene_models'
        ? [['genes', 'genes'], ['transcripts', 'transcripts'], ['features', 'features']]
        : stage === 'writing_annotation'
            ? [['records_written', 'records written'], ['genes', 'genes']]
            : stage === 'reading_fasta'
                ? [['sequences', 'sequences']]
                : [['features', 'features'], ['genes', 'genes'], ['transcripts', 'transcripts']]
    const counter = priority.find(
        ([key]) => Number.isFinite(Number(counters[key])) && Number(counters[key]) > 0,
    )
    const detail = counter
        ? `${Number(counters[counter[0]]).toLocaleString()} ${counter[1]}`
        : ''
    return [base, detail].filter(Boolean).join(' — ')
}

export const batchProgress = (completed, currentProgress, total) => {
    const count = Math.max(1, Number(total) || 0)
    const inner = Math.max(0, Math.min(100, Number(currentProgress) || 0)) / 100
    return Math.max(0, Math.min(100, ((Number(completed) || 0) + inner) / count * 100))
}

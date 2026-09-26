// What the Active downloads panel and the top-bar Active tasks menu show, built from
// the raw /api/remote/tasks list. Kept free of React so it can be unit tested.

import { fileTypeLabel } from './genomeFileTypes.js'
import { getAssemblyAccession, getAssemblyGenomeKey, normalizeGenomeSourceDatabase } from './genomeIdentity.js'

export const ACTIVE_DOWNLOAD_STATUSES = new Set(['pending', 'downloading'])

// Assembly metadata rides along with every FASTA and GFF3 download. It is a few
// kilobytes, and listing it beside the file the user asked for is noise.
const HIDDEN_FILE_TYPES = new Set(['metadata'])

export function isActiveDownloadTask(task) {
    return ACTIVE_DOWNLOAD_STATUSES.has(String(task?.status || ''))
}

function speciesNameFromKey(speciesKey) {
    const words = String(speciesKey || '').replace(/_/g, ' ').trim()
    return words ? words.charAt(0).toUpperCase() + words.slice(1) : ''
}

function taskProgress(task) {
    const value = Number(task?.progress || 0)
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
}

// Running files first, most complete at the top; then the queue in the order it
// will start.
function compareFiles(a, b) {
    if (a.status !== b.status) return a.status === 'downloading' ? -1 : 1
    if (a.status === 'downloading' && a.progress !== b.progress) return b.progress - a.progress
    return String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.id).localeCompare(String(b.id))
}

function toFile(task) {
    return {
        id: String(task.id || ''),
        type: String(task.file_type || ''),
        typeLabel: task.file_type ? fileTypeLabel(task.file_type) : String(task.filename || 'File'),
        filename: String(task.filename || ''),
        status: String(task.status || ''),
        progress: taskProgress(task),
        createdAt: String(task.created_at || ''),
    }
}

/**
 * Every queued or running download, one entry per genome.
 *
 * Returns `{ genomes, downloading, queued, taskIds }`. Each genome carries the names
 * to label it and its files; `taskIds` lists every active task including the hidden
 * metadata ones, so that cancelling a genome takes all of it.
 */
export function buildActiveDownloads(tasks) {
    const byGenome = new Map()
    let downloading = 0
    let queued = 0

    for (const task of Array.isArray(tasks) ? tasks : []) {
        if (!isActiveDownloadTask(task)) continue
        const key = getAssemblyGenomeKey(task) || `task:${task.id}`
        if (!byGenome.has(key)) {
            const scientificName = String(task.scientific_name || '').trim() || speciesNameFromKey(task.species_key)
            byGenome.set(key, {
                key,
                name: String(task.display_name || task.common_name || '').trim() || scientificName,
                scientificName,
                accession: getAssemblyAccession(task),
                assemblyName: String(task.assembly_name || '').trim(),
                source: normalizeGenomeSourceDatabase(task),
                files: [],
                taskIds: [],
            })
        }
        const genome = byGenome.get(key)
        genome.taskIds.push(String(task.id || ''))
        if (HIDDEN_FILE_TYPES.has(String(task.file_type || ''))) continue
        const file = toFile(task)
        genome.files.push(file)
        if (file.status === 'downloading') downloading += 1
        else queued += 1
    }

    const genomes = Array.from(byGenome.values())
        .filter((genome) => genome.files.length > 0)
    for (const genome of genomes) genome.files.sort(compareFiles)
    // A genome with something running sits above one that is only waiting.
    genomes.sort((a, b) => compareFiles(a.files[0], b.files[0]))

    return {
        genomes,
        downloading,
        queued,
        taskIds: genomes.flatMap((genome) => genome.taskIds),
    }
}

/**
 * The sections of the top-bar Active tasks menu. Downloads are the only kind today;
 * anything else long-running can add a section of the same shape.
 *
 * Each section: `{ id, title, active: [...], queuedCount, total, progress }`, where
 * `progress` is the mean across every file in it (queued ones count as 0).
 */
export function buildActiveTaskSections(tasks) {
    const { genomes, downloading, queued } = buildActiveDownloads(tasks)
    const active = []
    let progressSum = 0
    for (const genome of genomes) {
        for (const file of genome.files) {
            progressSum += file.progress
            if (file.status !== 'downloading') continue
            active.push({
                id: file.id,
                genomeName: genome.name,
                scientificName: genome.scientificName,
                assemblyName: genome.assemblyName,
                accession: genome.accession,
                typeLabel: file.typeLabel,
                progress: file.progress,
            })
        }
    }
    const total = downloading + queued
    if (total === 0) return []
    return [{
        id: 'downloads',
        title: 'Downloads',
        active,
        queuedCount: queued,
        total,
        progress: progressSum / total,
    }]
}

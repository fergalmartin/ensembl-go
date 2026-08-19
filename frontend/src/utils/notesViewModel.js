// How the Notes view arranges what the store holds: which genome sections there
// are and in what order, which genes sit under each, and what a search matches.
//
// Pure and separate from the markup, because this is the part with rules in it —
// the section ordering in particular is a product decision, not a rendering
// detail, and it is the thing most likely to drift once someone edits the view.

import {
    GENERAL_NOTES_TARGET_ID,
    NOTE_TARGET_KIND_GENE,
    NOTE_TARGET_KIND_GENOME,
    noteDisplayTitle,
    normalizeNoteGenomeKey,
} from './geneNotes.js'

/** How the gene rows inside a genome section can be ordered. */
export const GENE_SORT_MODES = [
    { id: 'recent_desc', label: 'Recently edited' },
    { id: 'recent_asc', label: 'Least recently edited' },
    { id: 'symbol_asc', label: 'Gene symbol A–Z' },
    { id: 'count_desc', label: 'Most notes' },
]
export const DEFAULT_GENE_SORT_MODE = 'recent_desc'

const text = (value) => (typeof value === 'string' ? value : (value == null ? '' : String(value)))

function latestStamp(notes) {
    let latest = ''
    for (const note of notes) {
        const stamp = text(note?.updatedAt) || text(note?.createdAt)
        if (stamp > latest) latest = stamp
    }
    return latest
}

/**
 * Gene rows for one genome's notes.
 *
 * The label is taken from the most recently edited note rather than the first:
 * a gene's symbol is denormalised onto every note when it is written, so the
 * freshest copy is the one most likely to match what the annotation calls it now.
 */
export function groupNotesByGene(notes, sortMode = DEFAULT_GENE_SORT_MODE) {
    const byGene = new Map()
    for (const note of (Array.isArray(notes) ? notes : [])) {
        const geneId = text(note?.target?.id).trim()
        if (!geneId) continue
        if (!byGene.has(geneId)) byGene.set(geneId, [])
        byGene.get(geneId).push(note)
    }

    const rows = []
    for (const [geneId, geneNotes] of byGene) {
        const activeNotes = geneNotes.filter((note) => !note?.archived)
        const archivedNotes = geneNotes.filter((note) => Boolean(note?.archived))
        const newest = geneNotes.reduce((best, note) => {
            const stamp = text(note?.updatedAt) || text(note?.createdAt)
            const bestStamp = text(best?.updatedAt) || text(best?.createdAt)
            return stamp > bestStamp ? note : best
        }, geneNotes[0])
        rows.push({
            geneId,
            label: text(newest?.target?.label).trim(),
            notes: geneNotes,
            count: geneNotes.length,
            activeCount: activeNotes.length,
            archivedCount: archivedNotes.length,
            updatedAt: latestStamp(geneNotes),
        })
    }

    return sortGeneRows(rows, sortMode)
}

export function sortGeneRows(rows, sortMode = DEFAULT_GENE_SORT_MODE) {
    const list = Array.isArray(rows) ? rows.slice() : []
    const byId = (a, b) => a.geneId.localeCompare(b.geneId)
    const bySymbol = (a, b) => (a.label || a.geneId).localeCompare(b.label || b.geneId, undefined, { sensitivity: 'base' })
    const comparators = {
        recent_desc: (a, b) => b.updatedAt.localeCompare(a.updatedAt) || byId(a, b),
        recent_asc: (a, b) => a.updatedAt.localeCompare(b.updatedAt) || byId(a, b),
        symbol_asc: (a, b) => bySymbol(a, b) || byId(a, b),
        count_desc: (a, b) => (b.count - a.count) || bySymbol(a, b) || byId(a, b),
    }
    return list.sort(comparators[sortMode] || comparators[DEFAULT_GENE_SORT_MODE])
}

/**
 * The view's genome sections, in the one order that makes sense here.
 *
 * The genomes the reader has loaded come first, in exactly the order their pills
 * sit in the top bar — including the ones with nothing written about them yet,
 * because "no notes on this genome" is itself worth seeing. Everything else they
 * have written about follows, most recently touched first, since those are
 * genomes they have to opt back in to before the browser can show them.
 */
export function buildNoteSections(notes, activeGenomes, { geneSortMode = DEFAULT_GENE_SORT_MODE } = {}) {
    const all = Array.isArray(notes) ? notes : []
    const byGenome = new Map()
    for (const note of all) {
        const kind = text(note?.target?.kind).trim()
        if (kind !== NOTE_TARGET_KIND_GENE && kind !== NOTE_TARGET_KIND_GENOME) continue
        const key = normalizeNoteGenomeKey(note?.target?.genome_key)
        if (!key) continue
        if (!byGenome.has(key)) byGenome.set(key, [])
        byGenome.get(key).push(note)
    }

    const sections = []
    const claimed = new Set()

    for (const genome of (Array.isArray(activeGenomes) ? activeGenomes : [])) {
        const key = normalizeNoteGenomeKey(genome?.notesGenomeKey)
        if (!key || claimed.has(key)) continue
        claimed.add(key)
        const genomeNotes = byGenome.get(key) || []
        const archivedNoteCount = genomeNotes.filter((note) => Boolean(note?.archived)).length
        const generalNotes = genomeNotes.filter((note) => (
            text(note?.target?.kind).trim() === NOTE_TARGET_KIND_GENOME
            && text(note?.target?.id).trim() === GENERAL_NOTES_TARGET_ID
        ))
        sections.push({
            genomeKey: key,
            genome,
            inTopBar: true,
            genes: groupNotesByGene(genomeNotes.filter((note) => text(note?.target?.kind).trim() === NOTE_TARGET_KIND_GENE), geneSortMode),
            generalNotes,
            generalActiveCount: generalNotes.filter((note) => !note?.archived).length,
            generalArchivedCount: generalNotes.filter((note) => Boolean(note?.archived)).length,
            noteCount: genomeNotes.length,
            activeNoteCount: genomeNotes.length - archivedNoteCount,
            archivedNoteCount,
            updatedAt: latestStamp(genomeNotes),
        })
    }

    const extras = []
    for (const [key, genomeNotes] of byGenome) {
        if (claimed.has(key)) continue
        const archivedNoteCount = genomeNotes.filter((note) => Boolean(note?.archived)).length
        const generalNotes = genomeNotes.filter((note) => (
            text(note?.target?.kind).trim() === NOTE_TARGET_KIND_GENOME
            && text(note?.target?.id).trim() === GENERAL_NOTES_TARGET_ID
        ))
        extras.push({
            genomeKey: key,
            genome: null,
            inTopBar: false,
            genes: groupNotesByGene(genomeNotes.filter((note) => text(note?.target?.kind).trim() === NOTE_TARGET_KIND_GENE), geneSortMode),
            generalNotes,
            generalActiveCount: generalNotes.filter((note) => !note?.archived).length,
            generalArchivedCount: generalNotes.filter((note) => Boolean(note?.archived)).length,
            noteCount: genomeNotes.length,
            activeNoteCount: genomeNotes.length - archivedNoteCount,
            archivedNoteCount,
            updatedAt: latestStamp(genomeNotes),
        })
    }
    extras.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.genomeKey.localeCompare(b.genomeKey))

    return [...sections, ...extras]
}

/**
 * Notes matching a query, over everything the store already holds.
 *
 * Gene symbol, stable id, note title and note body — the body included because
 * it costs nothing once the notes are in memory, and "what did I say about
 * coverage?" is a question people actually have.
 */
export function matchNotes(notes, query) {
    const needle = text(query).trim().toLowerCase()
    if (!needle) return Array.isArray(notes) ? notes : []
    return (Array.isArray(notes) ? notes : []).filter((note) => {
        const haystacks = [
            note?.target?.label,
            note?.target?.id,
            note?.title,
            note?.body,
            noteDisplayTitle(note),
        ]
        return haystacks.some((value) => text(value).toLowerCase().includes(needle))
    })
}

/** True when a query looks like something only the server can resolve. */
export function looksLikeFeatureId(query) {
    return /^[A-Za-z]{2,6}[0-9]{6,}(\.\d+)?$/.test(text(query).trim())
}

/** Totals for the view's header line. */
export function summariseNotes(sections) {
    let notes = 0
    let genes = 0
    let genomes = 0
    for (const section of (Array.isArray(sections) ? sections : [])) {
        if (!section.noteCount) continue
        genomes += 1
        genes += section.genes.length
        notes += section.noteCount
    }
    return { notes, genes, genomes }
}

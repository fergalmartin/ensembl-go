// The Notes export tree: what can be picked, what is picked, and what a click does.
//
// Pure and separate from the dialog, because the frontend test harness is bare
// `node --test` with no renderer — anything that lives inside a component is
// untestable, and the tri-state arithmetic is exactly the part worth testing.
//
// Two decisions shape everything here:
//
//   * **Selection is a flat Set of note ids.** Branch state is derived, never
//     stored. buildNoteSections hands back freshly constructed objects on every
//     render and nodes come and go as filters change, so per-node state would
//     need reconciling constantly; derived state has nothing to reconcile.
//   * **Node ids are opaque.** A genome key already contains '::', so splitting
//     an id apart is ambiguous. Everything a caller needs is a field on the node;
//     the id string is only a React key and a member of the expansion set.

import {
    GENERAL_NOTES_TARGET_ID,
    NOTE_TARGET_KIND_GENE,
    NOTE_TARGET_KIND_GENOME,
    NOTE_TARGET_KIND_LOCATION,
    NOTE_TARGET_KIND_TODO,
    noteDisplayTitle,
    normalizeNoteGenomeKey,
} from './geneNotes.js'
import { buildNoteSections, DEFAULT_GENE_SORT_MODE } from './notesViewModel.js'
import { matchTaggedNotes } from './noteTags.js'
import { sortTodos } from './todoNotes.js'
import { buildScreenshotTimestamp } from './screenshotExport.js'
import { genomeKeyDisplayLabels } from './genomeIdentity.js'

const text = (value) => (typeof value === 'string' ? value : (value == null ? '' : String(value)))

/**
 * Which notes the tree shows. Active is the default because it is what people
 * mean by "my notes"; archived and everything are one click away.
 *
 * 'selected' is the odd one out and deliberately so: it is a verification view,
 * so it ignores the search and tag filters and shows exactly what would be
 * exported. It is only usable once something is selected.
 */
export const TRANSFER_NOTE_SETS = [
    { id: 'active', label: 'Active only' },
    { id: 'archived', label: 'Archived only' },
    { id: 'selected', label: 'Selected only', requiresSelection: true },
    { id: 'both', label: 'All notes' },
]
export const DEFAULT_TRANSFER_NOTE_SET = 'active'

export const TRANSFER_FORMATS = [
    {
        id: 'json',
        ext: '.json',
        label: 'JSON',
        lossless: true,
        help: 'Everything, exactly. Use this for a backup or to move notes to another machine.',
    },
    {
        id: 'csv',
        ext: '.csv',
        label: 'CSV',
        lossless: false,
        help: 'Opens straight into Excel and Google Sheets.',
    },
    {
        id: 'tsv',
        ext: '.tsv',
        label: 'TSV',
        lossless: false,
        help: 'Tab-separated, for tools that prefer it.',
    },
]
export const DEFAULT_TRANSFER_FORMAT = 'json'

/** What a spreadsheet cannot promise, said once so the dialog can quote it. */
export const SPREADSHEET_CELL_LIMIT = 32767
export const SPREADSHEET_CAVEAT =
    'Excel and Google Sheets cut any cell off at 32,767 characters, so a very long '
    + 'note can lose its tail on the way back in. JSON has no such limit.'

export const MERGE_STRATEGIES = [
    {
        id: 'newer_wins',
        label: 'Keep whichever is newer',
        destructive: false,
        help: 'Where a note is in both places, the more recently edited copy wins. '
            + 'An empty imported note never replaces one you have written in.',
    },
    {
        id: 'replace_matching',
        label: 'The file wins',
        destructive: false,
        help: 'Where a note is in both places, the file replaces what is stored. '
            + 'Notes that are not in the file are left alone.',
    },
    {
        id: 'add_as_new',
        label: 'Import everything as new notes',
        destructive: false,
        help: 'Nothing is replaced. Every note in the file is added alongside what you '
            + 'already have, so you may end up with two copies.',
    },
    {
        id: 'replace_all',
        label: 'Delete everything, then import',
        destructive: true,
        help: 'Every note you have is removed and replaced by the file. A backup is '
            + 'written first.',
    },
]
export const DEFAULT_MERGE_STRATEGY = 'newer_wins'

export const TRANSFER_NODE_TYPES = {
    ROOT: 'root',
    GROUP: 'group',
    GENOME: 'genome',
    GENE: 'gene',
    GENERAL: 'general',
    NOTE: 'note',
}

export function describeStrategy(id) {
    return MERGE_STRATEGIES.find((strategy) => strategy.id === id) || null
}

export function transferFormat(id) {
    return TRANSFER_FORMATS.find((format) => format.id === id) || null
}

/** `ens_notes_20260819_141233.csv` — same timestamp shape as a screenshot. */
export function defaultTransferFilename(format, { date = new Date(), scope = 'notes' } = {}) {
    const chosen = transferFormat(format) || transferFormat(DEFAULT_TRANSFER_FORMAT)
    return `ens_${scope}_${buildScreenshotTimestamp(date)}${chosen.ext}`
}

function matchesNoteSet(note, noteSet) {
    if (noteSet === 'active') return !note?.archived
    if (noteSet === 'archived') return Boolean(note?.archived)
    return true
}

function asSet(value) {
    return value instanceof Set ? value : new Set(value || [])
}

/**
 * The candidate notes, after the filter row.
 *
 * Filtering only decides what the tree *shows*. What gets exported is the
 * selection and nothing else, so narrowing the view never quietly drops a note
 * the user already ticked — see selectionSummary for how that is surfaced.
 */
export function filterNotesForTransfer(notes, {
    query = '',
    selectedTags = [],
    tagMatchMode = 'all',
    noteSet = DEFAULT_TRANSFER_NOTE_SET,
    selectedIds = null,
} = {}) {
    const all = Array.isArray(notes) ? notes : []
    if (noteSet === 'selected') {
        const chosen = asSet(selectedIds)
        return all.filter((note) => chosen.has(note?.id))
    }
    const bySet = all.filter((note) => matchesNoteSet(note, noteSet))
    return matchTaggedNotes(bySet, { query, selectedTags, matchMode: tagMatchMode })
}

/**
 * The notes a tag filter picks out, as ids.
 *
 * Choosing a tag is a statement about what the user wants, not only about what
 * they want to look at, so the dialog turns the match into a selection rather
 * than making them tick the same rows again by hand.
 */
export function noteIdsForTagSelection(notes, {
    selectedTags = [],
    tagMatchMode = 'all',
    noteSet = DEFAULT_TRANSFER_NOTE_SET,
} = {}) {
    if (!Array.isArray(selectedTags) || selectedTags.length === 0) return []
    const set = noteSet === 'selected' ? 'both' : noteSet
    return filterNotesForTransfer(notes, { selectedTags, tagMatchMode, noteSet: set })
        .map((note) => note?.id)
        .filter(Boolean)
}

/** Every branch id in the tree — what "expand everything" needs. */
export function allExpandableNodeIds(tree) {
    const ids = []
    if (!tree?.root) return ids
    const walk = (node) => {
        for (const child of node.children || []) {
            if ((child.children || []).length > 0) {
                ids.push(child.id)
                walk(child)
            }
        }
    }
    walk(tree.root)
    return ids
}

function noteLeaf(note, parentId) {
    return {
        id: `${parentId}/note:${note.id}`,
        type: TRANSFER_NODE_TYPES.NOTE,
        label: noteDisplayTitle(note),
        noteId: note.id,
        note,
        archived: Boolean(note.archived),
        children: [],
    }
}

function countsFor(notes) {
    let archived = 0
    for (const note of notes) if (note?.archived) archived += 1
    return { total: notes.length, archived, active: notes.length - archived }
}

/**
 * The whole selectable tree, top level first.
 *
 * Todo list and Genome notes are peers, as asked. "Other" is the third peer and
 * exists for a reason worth writing down: buildNoteSections keeps only gene and
 * genome kinds, and the store also supports region notes. Without somewhere for
 * those to land, "select everything" would silently miss them — which in a
 * backup feature is data loss. It renders only when it has something in it.
 *
 * Genomes with no notes are left out. buildNoteSections includes empty top-bar
 * genomes on purpose, because "nothing written about this one yet" is worth
 * seeing while browsing; here a checkbox that selects nothing is just noise.
 */
export function buildTransferTree(notes, activeGenomes, {
    geneSortMode = DEFAULT_GENE_SORT_MODE,
    todoSortMode = 'manual',
} = {}) {
    const all = Array.isArray(notes) ? notes : []
    const todoNotes = []
    const sectionNotes = []
    const otherNotes = []

    for (const note of all) {
        const kind = text(note?.target?.kind).trim()
        if (kind === NOTE_TARGET_KIND_TODO) todoNotes.push(note)
        else if (
            kind === NOTE_TARGET_KIND_GENE
            || kind === NOTE_TARGET_KIND_GENOME
            || kind === NOTE_TARGET_KIND_LOCATION
        ) sectionNotes.push(note)
        else otherNotes.push(note)
    }

    const groups = []

    if (todoNotes.length > 0) {
        const sorted = sortTodos(todoNotes, todoSortMode)
        groups.push({
            id: 'group:todo',
            type: TRANSFER_NODE_TYPES.GROUP,
            group: 'todo',
            label: 'Todo list',
            counts: countsFor(sorted),
            children: sorted.map((note) => noteLeaf(note, 'group:todo')),
        })
    }

    const sections = buildNoteSections(sectionNotes, activeGenomes, { geneSortMode })
        .filter((section) => section.noteCount > 0)

    if (sections.length > 0) {
        groups.push({
            id: 'group:genomes',
            type: TRANSFER_NODE_TYPES.GROUP,
            group: 'genomes',
            label: 'Genome notes',
            counts: countsFor(sectionNotes),
            children: sections.map((section) => {
                const genomeId = `genome:${section.genomeKey}`
                const children = []

                if (section.generalNotes.length > 0) {
                    const generalId = `${genomeId}/general`
                    children.push({
                        id: generalId,
                        type: TRANSFER_NODE_TYPES.GENERAL,
                        genomeKey: section.genomeKey,
                        targetId: GENERAL_NOTES_TARGET_ID,
                        label: 'General notes',
                        counts: countsFor(section.generalNotes),
                        children: section.generalNotes.map((note) => noteLeaf(note, generalId)),
                    })
                }

                // Genes first, then the locations written about in this genome.
                // Both are "one target's notes", so they carry the same node type
                // and the tree needs no new case to select or move them.
                for (const geneRow of [...section.genes, ...section.locations]) {
                    const geneId = `${genomeId}/gene:${geneRow.geneId}`
                    children.push({
                        id: geneId,
                        type: TRANSFER_NODE_TYPES.GENE,
                        genomeKey: section.genomeKey,
                        geneId: geneRow.geneId,
                        label: geneRow.label || geneRow.geneId,
                        sublabel: geneRow.label ? geneRow.geneId : '',
                        counts: countsFor(geneRow.notes),
                        children: geneRow.notes.map((note) => noteLeaf(note, geneId)),
                    })
                }

                return {
                    id: genomeId,
                    type: TRANSFER_NODE_TYPES.GENOME,
                    genomeKey: section.genomeKey,
                    genome: section.genome,
                    inTopBar: section.inTopBar,
                    // A genome the user has notes on but no longer has loaded still
                    // has to read as a species name, not as a raw key.
                    label: section.genome?.name || genomeKeyDisplayLabels(section.genomeKey).displayName,
                    sublabel: section.genome?.assemblyName || genomeKeyDisplayLabels(section.genomeKey).displayAssembly,
                    counts: {
                        total: section.noteCount,
                        active: section.activeNoteCount,
                        archived: section.archivedNoteCount,
                    },
                    children,
                }
            }),
        })
    }

    if (otherNotes.length > 0) {
        groups.push({
            id: 'group:other',
            type: TRANSFER_NODE_TYPES.GROUP,
            group: 'other',
            label: 'Other notes',
            counts: countsFor(otherNotes),
            children: otherNotes.map((note) => noteLeaf(note, 'group:other')),
        })
    }

    const root = {
        id: 'root',
        type: TRANSFER_NODE_TYPES.ROOT,
        label: 'Everything',
        counts: countsFor(all),
        children: groups,
    }

    const nodesById = new Map()
    const leafIdsByNode = new Map()

    const walk = (node) => {
        nodesById.set(node.id, node)
        if (node.type === TRANSFER_NODE_TYPES.NOTE) {
            leafIdsByNode.set(node.id, [node.noteId])
            return [node.noteId]
        }
        const collected = []
        for (const child of node.children) collected.push(...walk(child))
        leafIdsByNode.set(node.id, collected)
        return collected
    }
    walk(root)

    return {
        root,
        nodesById,
        leafIdsByNode,
        totalNotes: all.length,
        kinds: {
            todo: todoNotes.length,
            genome: sectionNotes.length,
            other: otherNotes.length,
        },
    }
}

/**
 * Every node's checkbox state, in one post-order pass.
 *
 * Deliberately not a per-row predicate: calling one from each row is O(n·depth)
 * on every render, which is what makes a big tree feel sticky to click.
 */
export function computeSelectionStates(tree, selectedIds) {
    const chosen = selectedIds instanceof Set ? selectedIds : new Set(selectedIds || [])
    const states = new Map()
    if (!tree?.root) return states

    const visit = (node) => {
        if (node.type === TRANSFER_NODE_TYPES.NOTE) {
            const state = chosen.has(node.noteId) ? 'all' : 'none'
            states.set(node.id, state)
            return state
        }
        let selected = 0
        let partial = false
        for (const child of node.children) {
            const state = visit(child)
            if (state === 'all') selected += 1
            else if (state === 'partial') partial = true
        }
        const state = node.children.length === 0
            ? 'none'
            : (partial || (selected > 0 && selected < node.children.length))
                ? 'partial'
                : (selected === node.children.length ? 'all' : 'none')
        states.set(node.id, state)
        return state
    }
    visit(tree.root)
    return states
}

/**
 * Clicking a checkbox.
 *
 * A partially selected branch selects the rest rather than clearing — the
 * conventional reading of a half-filled box, and the less destructive one.
 */
export function toggleNode(selectedIds, tree, node, states) {
    const next = new Set(selectedIds instanceof Set ? selectedIds : (selectedIds || []))
    const leafIds = tree?.leafIdsByNode?.get(node?.id) || []
    const state = states?.get(node?.id) || 'none'
    if (state === 'all') for (const id of leafIds) next.delete(id)
    else for (const id of leafIds) next.add(id)
    return next
}

export function setNodeSelected(selectedIds, tree, node, selected) {
    const next = new Set(selectedIds instanceof Set ? selectedIds : (selectedIds || []))
    const leafIds = tree?.leafIdsByNode?.get(node?.id) || []
    for (const id of leafIds) {
        if (selected) next.add(id)
        else next.delete(id)
    }
    return next
}

/**
 * What the footer says.
 *
 * `hiddenSelectedCount` is the number that matters: a selection made under one
 * filter is still exported under another, and the user has to be told rather
 * than surprised.
 */
export function selectionSummary(tree, selectedIds, allNotesById) {
    const chosen = selectedIds instanceof Set ? selectedIds : new Set(selectedIds || [])
    const visible = new Set(tree?.leafIdsByNode?.get('root') || [])
    const lookup = allNotesById instanceof Map ? allNotesById : new Map()

    let visibleSelectedCount = 0
    let hiddenSelectedCount = 0
    let todoCount = 0
    let noteCount = 0
    let archivedCount = 0
    const genomes = new Set()

    for (const noteId of chosen) {
        if (visible.has(noteId)) visibleSelectedCount += 1
        else hiddenSelectedCount += 1
        const note = lookup.get(noteId)
        if (!note) continue
        if (note.archived) archivedCount += 1
        if (text(note?.target?.kind).trim() === NOTE_TARGET_KIND_TODO) {
            todoCount += 1
        } else {
            noteCount += 1
            const key = normalizeNoteGenomeKey(note?.target?.genome_key)
            if (key) genomes.add(key)
        }
    }

    return {
        selectedCount: chosen.size,
        visibleSelectedCount,
        hiddenSelectedCount,
        todoCount,
        noteCount,
        archivedCount,
        genomeCount: genomes.size,
        availableCount: visible.size,
    }
}

/** The one-line verdict on a scan, and whether applying it is a good idea. */
export function summariseScan(scan) {
    if (!scan) return null
    const summary = scan.summary || {}
    const documentErrors = scan.document_errors || []
    const rows = Array.isArray(scan.rows) ? scan.rows : []
    const warningCount = rows.reduce((total, row) => total + ((row.warnings || []).length), 0)
    return {
        format: scan.format || '',
        filename: scan.filename || '',
        total: scan.total || 0,
        applicable: scan.applicable || 0,
        newCount: summary.new || 0,
        identicalCount: summary.identical || 0,
        differsCount: summary.differs || 0,
        invalidCount: summary.invalid || 0,
        todoCount: summary.todos || 0,
        noteCount: summary.notes || 0,
        archivedCount: summary.archived || 0,
        nearDuplicateCount: (scan.near_duplicates || []).length,
        warningCount,
        documentErrors,
        documentWarnings: scan.document_warnings || [],
        blocked: documentErrors.length > 0 || (scan.applicable || 0) === 0,
    }
}

/** What `replace_all` would remove, for the confirm step to say out loud. */
export function projectedDeletions(scan, strategy) {
    if (strategy !== 'replace_all' || !scan) return 0
    const stored = scan.stored_total || 0
    const summary = scan.summary || {}
    const kept = (summary.identical || 0) + (summary.differs || 0)
    return Math.max(0, stored - kept)
}

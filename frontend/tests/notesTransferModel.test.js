// The export tree and its checkboxes: what is offered, what a click does, and
// what the footer is obliged to admit.

import test from 'node:test'
import assert from 'node:assert/strict'

import {
    DEFAULT_TRANSFER_FORMAT,
    DEFAULT_TRANSFER_NOTE_SET,
    TRANSFER_NOTE_SETS,
    allExpandableNodeIds,
    noteIdsForTagSelection,
    MERGE_STRATEGIES,
    TRANSFER_NODE_TYPES,
    buildTransferTree,
    computeSelectionStates,
    defaultTransferFilename,
    describeStrategy,
    filterNotesForTransfer,
    projectedDeletions,
    selectionSummary,
    setNodeSelected,
    summariseScan,
    toggleNode,
} from '../src/utils/notesTransferModel.js'

const HUMAN = 'ensembl::Homo_sapiens::GCA_000001405.29'
const WORM = 'ensembl::Caenorhabditis_elegans::GCA_000002985.3'

function note(id, {
    kind = 'gene',
    genomeKey = HUMAN,
    targetId = 'ENSG00000141510',
    label = 'TP53',
    title = '',
    body = 'text',
    tags = [],
    archived = false,
    updatedAt = '2026-01-02T00:00:00Z',
    todoOrder = 0,
} = {}) {
    return {
        id,
        title,
        body,
        tags,
        archived,
        updatedAt,
        createdAt: '2026-01-01T00:00:00Z',
        todoOrder,
        status: 'backlog',
        priority: 'medium',
        completed: false,
        target: { kind, genome_key: genomeKey, id: targetId, label, genome_selection_key: '' },
    }
}

function todo(id, title, extra = {}) {
    return note(id, {
        kind: 'todo', genomeKey: 'global::todos', targetId: 'tasks', label: 'Todo', title, ...extra,
    })
}

function general(id, genomeKey, extra = {}) {
    return note(id, { kind: 'genome', genomeKey, targetId: 'general', label: 'General notes', ...extra })
}

const GENOMES = [
    { notesGenomeKey: HUMAN, name: 'Human' },
    { notesGenomeKey: WORM, name: 'C. elegans' },
]

const FIXTURE = [
    todo('t1', 'Check REG4'),
    todo('t2', 'Rerun stats'),
    general('g1', HUMAN),
    note('n1', { targetId: 'ENSG00000141510', label: 'TP53' }),
    note('n2', { targetId: 'ENSG00000141510', label: 'TP53' }),
    note('n3', { targetId: 'ENSG00000134193', label: 'REG4' }),
    note('w1', { genomeKey: WORM, targetId: 'WBGene00000912', label: 'daf-2' }),
    note('r1', { kind: 'region', targetId: 'chr17:7668402-7687550', label: '' }),
]

const byId = new Map(FIXTURE.map((n) => [n.id, n]))

function ids(tree, nodeId) {
    return tree.leafIdsByNode.get(nodeId) || []
}

test('the tree has Todo list and Genome notes as peers at the top', () => {
    const tree = buildTransferTree(FIXTURE, GENOMES)
    const labels = tree.root.children.map((child) => child.label)
    assert.deepEqual(labels, ['Todo list', 'Genome notes', 'Other notes'])
})

test('region notes land in Other rather than vanishing from a full export', () => {
    const tree = buildTransferTree(FIXTURE, GENOMES)
    assert.deepEqual(ids(tree, 'group:other'), ['r1'])
    // Everything in the store is reachable from the root.
    assert.equal(ids(tree, 'root').length, FIXTURE.length)
})

test('Other is omitted entirely when there is nothing unusual', () => {
    const tree = buildTransferTree(FIXTURE.filter((n) => n.id !== 'r1'), GENOMES)
    assert.deepEqual(tree.root.children.map((c) => c.label), ['Todo list', 'Genome notes'])
})

test('genomes drill down to general notes and per-gene groups', () => {
    const tree = buildTransferTree(FIXTURE, GENOMES)
    const genomes = tree.nodesById.get('group:genomes').children
    assert.deepEqual(genomes.map((g) => g.label), ['Human', 'C. elegans'])

    const human = genomes[0]
    assert.equal(human.type, TRANSFER_NODE_TYPES.GENOME)
    assert.equal(human.children[0].type, TRANSFER_NODE_TYPES.GENERAL)
    const geneLabels = human.children.slice(1).map((child) => child.label)
    assert.deepEqual(geneLabels.sort(), ['REG4', 'TP53'])
})

test('a gene node holds its individual notes as leaves', () => {
    const tree = buildTransferTree(FIXTURE, GENOMES)
    const geneNodeId = `genome:${HUMAN}/gene:ENSG00000141510`
    assert.deepEqual(ids(tree, geneNodeId).sort(), ['n1', 'n2'])
})

test('a genome the user no longer has loaded still reads as a species name', () => {
    // Notes outlive their genomes, so the section for one that was removed from
    // the top bar must not fall back to showing the raw ensembl::…::GCA_… key.
    const orphan = note('o1', { genomeKey: 'ensembl::Acomys_cahirinus::GCA_029890205.1', targetId: 'G1' })
    const tree = buildTransferTree([orphan], [])
    const genome = tree.nodesById.get('group:genomes').children[0]
    assert.equal(genome.label, 'Acomys cahirinus')
    assert.equal(genome.sublabel, 'GCA_029890205.1')
    assert.ok(!genome.label.includes('::'))
})

test('a genome key that parses to nothing still gets a readable label', () => {
    const tree = buildTransferTree([note('o1', { genomeKey: 'mystery', targetId: 'G1' })], [])
    assert.equal(tree.nodesById.get('group:genomes').children[0].label, 'Unavailable genome')
})

test('genomes with no notes are left out of the export tree', () => {
    const withEmpty = [...GENOMES, { notesGenomeKey: 'ensembl::Mus_musculus::GCA_1', name: 'Mouse' }]
    const tree = buildTransferTree(FIXTURE, withEmpty)
    const labels = tree.nodesById.get('group:genomes').children.map((g) => g.label)
    assert.ok(!labels.includes('Mouse'))
})

test('node ids survive genome keys that contain the :: separator', () => {
    const tree = buildTransferTree(FIXTURE, GENOMES)
    const node = tree.nodesById.get(`genome:${HUMAN}`)
    // The key is carried as a field, never recovered by splitting the id.
    assert.equal(node.genomeKey, HUMAN)
    assert.ok(node.id.includes('::'))
})

test('a partial branch reports partial, a full one reports all', () => {
    const tree = buildTransferTree(FIXTURE, GENOMES)
    const geneNodeId = `genome:${HUMAN}/gene:ENSG00000141510`

    let states = computeSelectionStates(tree, new Set(['n1']))
    assert.equal(states.get(geneNodeId), 'partial')
    assert.equal(states.get('group:genomes'), 'partial')
    assert.equal(states.get('root'), 'partial')

    states = computeSelectionStates(tree, new Set(['n1', 'n2']))
    assert.equal(states.get(geneNodeId), 'all')
    assert.equal(states.get('group:genomes'), 'partial')
})

test('selecting everything propagates all the way to the root', () => {
    const tree = buildTransferTree(FIXTURE, GENOMES)
    const states = computeSelectionStates(tree, new Set(FIXTURE.map((n) => n.id)))
    assert.equal(states.get('root'), 'all')
    assert.equal(states.get('group:todo'), 'all')
})

test('an empty selection is none everywhere', () => {
    const tree = buildTransferTree(FIXTURE, GENOMES)
    const states = computeSelectionStates(tree, new Set())
    assert.equal(states.get('root'), 'none')
    assert.equal(states.get(`genome:${HUMAN}`), 'none')
})

test('toggling a group selects its whole subtree', () => {
    const tree = buildTransferTree(FIXTURE, GENOMES)
    const states = computeSelectionStates(tree, new Set())
    const next = toggleNode(new Set(), tree, tree.nodesById.get('group:todo'), states)
    assert.deepEqual([...next].sort(), ['t1', 't2'])
})

test('toggling a fully selected group clears it', () => {
    const tree = buildTransferTree(FIXTURE, GENOMES)
    const selected = new Set(['t1', 't2'])
    const states = computeSelectionStates(tree, selected)
    const next = toggleNode(selected, tree, tree.nodesById.get('group:todo'), states)
    assert.equal(next.size, 0)
})

test('toggling a partial branch fills it in rather than clearing it', () => {
    const tree = buildTransferTree(FIXTURE, GENOMES)
    const selected = new Set(['t1'])
    const states = computeSelectionStates(tree, selected)
    const next = toggleNode(selected, tree, tree.nodesById.get('group:todo'), states)
    assert.deepEqual([...next].sort(), ['t1', 't2'])
})

test('toggling a leaf touches only that note', () => {
    const tree = buildTransferTree(FIXTURE, GENOMES)
    const leafId = `genome:${HUMAN}/gene:ENSG00000141510/note:n1`
    const states = computeSelectionStates(tree, new Set())
    const next = toggleNode(new Set(['t1']), tree, tree.nodesById.get(leafId), states)
    assert.deepEqual([...next].sort(), ['n1', 't1'])
})

test('setNodeSelected is explicit in both directions', () => {
    const tree = buildTransferTree(FIXTURE, GENOMES)
    const group = tree.nodesById.get('group:todo')
    const on = setNodeSelected(new Set(), tree, group, true)
    assert.equal(on.size, 2)
    assert.equal(setNodeSelected(on, tree, group, false).size, 0)
})

test('the archived filter narrows what the tree offers', () => {
    const notes = [note('a1', { archived: true }), note('a2')]
    assert.equal(filterNotesForTransfer(notes, { noteSet: 'both' }).length, 2)
    assert.equal(filterNotesForTransfer(notes, { noteSet: 'active' }).length, 1)
    assert.deepEqual(filterNotesForTransfer(notes, { noteSet: 'archived' }).map((n) => n.id), ['a1'])
})

test('active only is the default, and leads the options', () => {
    assert.equal(DEFAULT_TRANSFER_NOTE_SET, 'active')
    assert.deepEqual(TRANSFER_NOTE_SETS.map((s) => s.id), ['active', 'archived', 'selected', 'both'])
    assert.equal(TRANSFER_NOTE_SETS.find((s) => s.id === 'selected').requiresSelection, true)
})

test('the selected view shows exactly the selection, ignoring search and tags', () => {
    // It exists to answer "what am I about to export?", so a filter that hid
    // part of the answer would defeat it.
    const notes = [note('a1', { tags: ['REG4'] }), note('a2', { tags: ['Human'], archived: true })]
    const shown = filterNotesForTransfer(notes, {
        noteSet: 'selected',
        selectedIds: new Set(['a2']),
        query: 'no match at all',
        selectedTags: ['REG4'],
    })
    assert.deepEqual(shown.map((n) => n.id), ['a2'])
})

test('the selected view is empty when nothing is selected', () => {
    const notes = [note('a1'), note('a2')]
    assert.deepEqual(filterNotesForTransfer(notes, { noteSet: 'selected', selectedIds: new Set() }), [])
})

test('a tag filter yields the ids it matches, so choosing a tag can select them', () => {
    const notes = [
        note('a1', { tags: ['REG4'] }),
        note('a2', { tags: ['REG4', 'Human'] }),
        note('a3', { tags: ['Human'] }),
    ]
    assert.deepEqual(noteIdsForTagSelection(notes, { selectedTags: ['REG4'] }).sort(), ['a1', 'a2'])
    assert.deepEqual(
        noteIdsForTagSelection(notes, { selectedTags: ['REG4', 'Human'], tagMatchMode: 'all' }),
        ['a2'],
    )
    assert.deepEqual(
        noteIdsForTagSelection(notes, { selectedTags: ['REG4', 'Human'], tagMatchMode: 'any' }).sort(),
        ['a1', 'a2', 'a3'],
    )
})

test('a tag selection respects the active/archived filter', () => {
    const notes = [note('a1', { tags: ['REG4'] }), note('a2', { tags: ['REG4'], archived: true })]
    assert.deepEqual(noteIdsForTagSelection(notes, { selectedTags: ['REG4'], noteSet: 'active' }), ['a1'])
    assert.deepEqual(noteIdsForTagSelection(notes, { selectedTags: ['REG4'], noteSet: 'both' }).sort(), ['a1', 'a2'])
})

test('no tags selected means no tag-driven selection', () => {
    assert.deepEqual(noteIdsForTagSelection(FIXTURE, { selectedTags: [] }), [])
})

test('expanding everything names each branch and no leaves', () => {
    const tree = buildTransferTree(FIXTURE, GENOMES)
    const ids = allExpandableNodeIds(tree)
    assert.ok(ids.includes('group:genomes'))
    assert.ok(ids.includes(`genome:${HUMAN}`))
    assert.ok(ids.includes(`genome:${HUMAN}/gene:ENSG00000141510`))
    assert.ok(!ids.some((id) => id.includes('/note:')), 'a note has nothing to expand')
    assert.ok(!ids.includes('root'), 'the root is never a row')
})

test('a tree with only leaves has nothing to expand', () => {
    const tree = buildTransferTree([todo('t1', 'One')], GENOMES)
    assert.deepEqual(allExpandableNodeIds(tree), ['group:todo'])
})

test('tag and text filters narrow the candidates', () => {
    const notes = [
        note('a1', { tags: ['REG4'], body: 'coverage dip' }),
        note('a2', { tags: ['Human'], body: 'nothing here' }),
    ]
    assert.deepEqual(
        filterNotesForTransfer(notes, { selectedTags: ['REG4'] }).map((n) => n.id),
        ['a1'],
    )
    assert.deepEqual(
        filterNotesForTransfer(notes, { query: 'coverage' }).map((n) => n.id),
        ['a1'],
    )
})

test('filtering decides what is shown, never what gets exported', () => {
    // The export sends the selection. Narrowing the view must not silently
    // drop a note the user already ticked.
    const notes = [note('a1', { tags: ['REG4'] }), note('a2', { tags: ['Human'] })]
    const selected = new Set(['a1', 'a2'])
    const shown = filterNotesForTransfer(notes, { selectedTags: ['REG4'] })
    const tree = buildTransferTree(shown, GENOMES)
    const summary = selectionSummary(tree, selected, new Map(notes.map((n) => [n.id, n])))

    assert.deepEqual(shown.map((n) => n.id), ['a1'])
    assert.equal(summary.selectedCount, 2)
    assert.equal(summary.hiddenSelectedCount, 1)
})

test('a selection hidden by a filter is still counted, and reported as hidden', () => {
    const filtered = filterNotesForTransfer(FIXTURE, { query: 'REG4' })
    const tree = buildTransferTree(filtered, GENOMES)
    const summary = selectionSummary(tree, new Set(['n3', 'w1']), byId)

    assert.equal(summary.selectedCount, 2)
    assert.equal(summary.visibleSelectedCount, 1)
    assert.equal(summary.hiddenSelectedCount, 1)
})

test('the summary breaks a selection down by kind', () => {
    const tree = buildTransferTree(FIXTURE, GENOMES)
    const summary = selectionSummary(tree, new Set(['t1', 'n1', 'w1']), byId)
    assert.equal(summary.todoCount, 1)
    assert.equal(summary.noteCount, 2)
    assert.equal(summary.genomeCount, 2)
    assert.equal(summary.hiddenSelectedCount, 0)
})

test('archived notes in a selection are counted', () => {
    const notes = [note('a1', { archived: true }), note('a2')]
    const tree = buildTransferTree(notes, GENOMES)
    const summary = selectionSummary(tree, new Set(['a1', 'a2']), new Map(notes.map((n) => [n.id, n])))
    assert.equal(summary.archivedCount, 1)
})

test('the default filename carries the format extension', () => {
    const date = new Date(2026, 7, 19, 14, 12, 33)
    assert.equal(defaultTransferFilename('json', { date }), 'ens_notes_20260819_141233.json')
    assert.equal(defaultTransferFilename('csv', { date }), 'ens_notes_20260819_141233.csv')
    assert.equal(defaultTransferFilename('tsv', { date }), 'ens_notes_20260819_141233.tsv')
})

test('an unknown format falls back to the default rather than producing a bad name', () => {
    const date = new Date(2026, 7, 19, 14, 12, 33)
    assert.ok(defaultTransferFilename('exe', { date }).endsWith('.json'))
    assert.equal(DEFAULT_TRANSFER_FORMAT, 'json')
})

test('exactly one merge strategy is destructive', () => {
    const destructive = MERGE_STRATEGIES.filter((strategy) => strategy.destructive)
    assert.deepEqual(destructive.map((s) => s.id), ['replace_all'])
    assert.equal(describeStrategy('replace_all').destructive, true)
    assert.equal(describeStrategy('newer_wins').destructive, false)
    assert.equal(describeStrategy('nonsense'), null)
})

test('a scan with document errors is blocked', () => {
    const summary = summariseScan({ document_errors: ['missing id column'], rows: [], applicable: 0 })
    assert.equal(summary.blocked, true)
})

test('a scan with nothing applicable is blocked', () => {
    assert.equal(summariseScan({ document_errors: [], rows: [], applicable: 0 }).blocked, true)
})

test('a healthy scan is not blocked and totals its warnings', () => {
    const summary = summariseScan({
        format: 'csv',
        filename: 'notes.csv',
        total: 3,
        applicable: 3,
        stored_total: 5,
        summary: { new: 1, identical: 1, differs: 1, invalid: 0, todos: 1, notes: 2, archived: 0 },
        rows: [{ warnings: ['a'] }, { warnings: ['b', 'c'] }, { warnings: [] }],
        near_duplicates: [{ incoming_id: 'x', existing_id: 'y' }],
        document_errors: [],
    })
    assert.equal(summary.blocked, false)
    assert.equal(summary.warningCount, 3)
    assert.equal(summary.nearDuplicateCount, 1)
    assert.equal(summary.newCount, 1)
})

test('replace_all projects how many stored notes it would remove', () => {
    const scan = { stored_total: 10, summary: { identical: 2, differs: 1 } }
    assert.equal(projectedDeletions(scan, 'replace_all'), 7)
    assert.equal(projectedDeletions(scan, 'newer_wins'), 0)
    assert.equal(projectedDeletions(null, 'replace_all'), 0)
})

test('an empty store produces a tree with no groups', () => {
    const tree = buildTransferTree([], GENOMES)
    assert.deepEqual(tree.root.children, [])
    assert.equal(computeSelectionStates(tree, new Set()).get('root'), 'none')
    assert.equal(selectionSummary(tree, new Set(), byId).availableCount, 0)
})

import assert from 'node:assert/strict'
import test from 'node:test'

import {
    DEFAULT_NOTE_SORT_MODE,
    NOTE_SAVE_STATES,
    buildGeneNoteTarget,
    geneNoteTargetKey,
    hasNotesForGene,
    indexEntriesToCountMap,
    nextRetryDelayMs,
    nextSaveState,
    noteCountsByTarget,
    noteDisplayTitle,
    noteEditableFieldsMatch,
    noteIsBlank,
    notePreview,
    noteTimestampLabel,
    normalizeNote,
    normalizeNoteGenomeKey,
    normalizeNoteList,
    removeNote,
    replaceNoteId,
    sortNotes,
    upsertNote,
} from '../src/utils/geneNotes.js'

const GENOME_KEY = 'ensembl::homo_sapiens::GRCh38'

function note(overrides = {}) {
    return {
        id: 'note_1',
        title: '',
        body: '',
        createdAt: '2026-08-01T09:00:00Z',
        updatedAt: '2026-08-01T09:00:00Z',
        target: { kind: 'gene', genome_key: GENOME_KEY, id: 'ENSG1', label: 'TP53', genome_selection_key: '' },
        ...overrides,
    }
}

// ── Titles and previews ─────────────────────────────────────────────────────

test('a note is named by its title, its opening line, or nothing', () => {
    assert.equal(noteDisplayTitle(note({ title: 'Splice check', body: 'Exon 4 differs.' })), 'Splice check')
    assert.equal(noteDisplayTitle(note({ body: '\n\n  Exon 4 differs.\nmore' })), 'Exon 4 differs.')
    assert.equal(noteDisplayTitle(note({ body: '   \n  ' })), 'Untitled note')
})

test('a long title is cut short rather than allowed to run', () => {
    const title = noteDisplayTitle(note({ title: 'x'.repeat(200) }), { max: 20 })
    assert.equal(title.length, 20)
    assert.ok(title.endsWith('…'))
})

test('the preview does not repeat the line already used as the title', () => {
    const untitled = note({ body: 'Exon 4 differs.\nChecked against RefSeq.' })
    assert.equal(notePreview(untitled), 'Checked against RefSeq.')

    // With a real title, the body's first line is still content.
    const titled = note({ title: 'Splice check', body: 'Exon 4 differs.\nChecked against RefSeq.' })
    assert.equal(notePreview(titled), 'Exon 4 differs. Checked against RefSeq.')
})

test('the preview collapses whitespace and ellipsises past the limit', () => {
    const long = note({ title: 't', body: 'a'.repeat(50) })
    assert.equal(notePreview(long, { max: 10 }).length, 10)
    assert.equal(notePreview(note({ title: 't', body: 'one\n\n  two   three' })), 'one two three')
    assert.equal(notePreview(note({ body: 'only one line' })), '')
})

test('a note with neither title nor body is blank', () => {
    assert.equal(noteIsBlank(note()), true)
    assert.equal(noteIsBlank(note({ body: '  \n ' })), true)
    assert.equal(noteIsBlank(note({ title: 'x' })), false)
    assert.equal(noteIsBlank(note({ body: 'x' })), false)
})

// ── Keys ────────────────────────────────────────────────────────────────────

test('the dataset release is stripped, so a note survives a release upgrade', () => {
    assert.equal(normalizeNoteGenomeKey(`${GENOME_KEY}::dataset::release_116`), GENOME_KEY)
    assert.equal(normalizeNoteGenomeKey(GENOME_KEY), GENOME_KEY)
    assert.equal(normalizeNoteGenomeKey('  '), '')
    assert.equal(normalizeNoteGenomeKey(null), '')

    assert.equal(
        geneNoteTargetKey(`${GENOME_KEY}::dataset::release_116`, 'ENSG1'),
        geneNoteTargetKey(`${GENOME_KEY}::dataset::release_117`, 'ENSG1'),
    )
})

test('a target key needs both a genome and a feature', () => {
    assert.equal(geneNoteTargetKey('', 'ENSG1'), '')
    assert.equal(geneNoteTargetKey(GENOME_KEY, ''), '')
    assert.ok(geneNoteTargetKey(GENOME_KEY, 'ENSG1'))
})

test('buildGeneNoteTarget keeps the selection key as provenance only', () => {
    const target = buildGeneNoteTarget({
        genomeKey: `${GENOME_KEY}::dataset::release_116`,
        selectionKey: `${GENOME_KEY}::dataset::release_116`,
        geneId: ' ENSG1 ',
        geneLabel: 'TP53',
    })
    assert.equal(target.genome_key, GENOME_KEY)
    assert.equal(target.genome_selection_key, `${GENOME_KEY}::dataset::release_116`)
    assert.equal(target.id, 'ENSG1')
    assert.equal(target.kind, 'gene')
})

// ── Normalisation ───────────────────────────────────────────────────────────

test('normalizeNote coerces missing and wrong-typed fields without throwing', () => {
    const parsed = normalizeNote({
        id: 'note_1',
        target: { genome_key: GENOME_KEY, id: 'ENSG1' },
        created_at: '2026-08-01T09:00:00Z',
    })
    assert.equal(parsed.title, '')
    assert.equal(parsed.body, '')
    assert.deepEqual(parsed.tags, [])
    assert.equal(parsed.tagsUpdatedAt, '')
    assert.equal(parsed.target.kind, 'gene')
    assert.equal(parsed.archived, false)
    assert.equal(parsed.archivedAt, '')
    assert.equal(parsed.status, 'backlog')
    assert.equal(parsed.priority, 'medium')
    assert.equal(parsed.completed, false)
    assert.equal(parsed.todoOrder, 0)
    // With no updated_at, the note has never been edited since it was written.
    assert.equal(parsed.updatedAt, '2026-08-01T09:00:00Z')

    assert.equal(normalizeNote(null), null)
    assert.equal(normalizeNote({ target: { genome_key: GENOME_KEY, id: 'ENSG1' } }), null)
    assert.equal(normalizeNote({ id: 'x', target: { id: 'ENSG1' } }), null)
    assert.equal(normalizeNote({ id: 'x', target: { genome_key: GENOME_KEY } }), null)
})

test('normalizeNote preserves archive state and its timestamp', () => {
    const parsed = normalizeNote({
        id: 'note_archived',
        target: { genome_key: GENOME_KEY, id: 'ENSG1' },
        created_at: '2026-08-01T09:00:00Z',
        archived: true,
        archived_at: '2026-08-18T10:00:00Z',
    })
    assert.equal(parsed.archived, true)
    assert.equal(parsed.archivedAt, '2026-08-18T10:00:00Z')
})

test('normalizeNote preserves normalized tag metadata', () => {
    const parsed = normalizeNote({
        id: 'note_tags',
        target: { genome_key: GENOME_KEY, id: 'ENSG1' },
        created_at: '2026-08-01T09:00:00Z',
        updated_at: '2026-08-18T10:00:00Z',
        tags: [' Needs   review ', 'RNA-seq', 'needs review'],
        tags_updated_at: '2026-08-17T10:00:00Z',
    })
    assert.deepEqual(parsed.tags, ['Needs review', 'RNA-seq'])
    assert.equal(parsed.tagsUpdatedAt, '2026-08-17T10:00:00Z')
})

test('normalizeNote preserves todo workflow metadata', () => {
    const parsed = normalizeNote({
        id: 'note_todo',
        target: { kind: 'todo', genome_key: 'global::todos', id: 'tasks' },
        title: 'Review notes',
        created_at: '2026-08-01T09:00:00Z',
        status: 'in_progress',
        priority: 'high',
        completed: true,
        completed_at: '2026-08-18T12:00:00Z',
        todo_order: 2048,
    })
    assert.equal(parsed.status, 'completed')
    assert.equal(parsed.priority, 'high')
    assert.equal(parsed.completed, true)
    assert.equal(parsed.completedAt, '2026-08-18T12:00:00Z')
    assert.equal(parsed.todoOrder, 2048)
})

test('normalizeNoteList drops unusable records instead of the whole list', () => {
    const list = normalizeNoteList([
        { id: 'a', target: { genome_key: GENOME_KEY, id: 'ENSG1' }, created_at: 't' },
        null,
        { id: 'b' },
        { id: 'c', target: { genome_key: GENOME_KEY, id: 'ENSG2' }, created_at: 't' },
    ])
    assert.deepEqual(list.map((n) => n.id), ['a', 'c'])
    assert.deepEqual(normalizeNoteList('nope'), [])
})

// ── Ordering ────────────────────────────────────────────────────────────────

test('sortNotes orders by each mode and never mutates its input', () => {
    const notes = [
        note({ id: 'b', title: 'Beta', createdAt: '2026-08-02T00:00:00Z', updatedAt: '2026-08-05T00:00:00Z' }),
        note({ id: 'a', title: 'Alpha', createdAt: '2026-08-03T00:00:00Z', updatedAt: '2026-08-04T00:00:00Z' }),
        note({ id: 'c', title: 'Gamma', createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-06T00:00:00Z' }),
    ]
    const snapshot = notes.map((n) => n.id)

    assert.deepEqual(sortNotes(notes, 'updated_desc').map((n) => n.id), ['c', 'b', 'a'])
    assert.deepEqual(sortNotes(notes, 'updated_asc').map((n) => n.id), ['a', 'b', 'c'])
    assert.deepEqual(sortNotes(notes, 'created_desc').map((n) => n.id), ['a', 'b', 'c'])
    assert.deepEqual(sortNotes(notes, 'created_asc').map((n) => n.id), ['c', 'b', 'a'])
    assert.deepEqual(sortNotes(notes, 'title_asc').map((n) => n.id), ['a', 'b', 'c'])

    assert.deepEqual(notes.map((n) => n.id), snapshot)
})

test('sortNotes breaks ties on id so the order cannot wobble', () => {
    const same = { createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z', title: 'Same' }
    const notes = [note({ id: 'c', ...same }), note({ id: 'a', ...same }), note({ id: 'b', ...same })]
    for (const mode of ['updated_desc', 'created_desc', 'title_asc']) {
        assert.deepEqual(sortNotes(notes, mode).map((n) => n.id), ['a', 'b', 'c'], mode)
    }
})

test('an unknown sort mode falls back to the default rather than losing notes', () => {
    const notes = [note({ id: 'a', updatedAt: '2026-08-01T00:00:00Z' }), note({ id: 'b', updatedAt: '2026-08-02T00:00:00Z' })]
    assert.deepEqual(
        sortNotes(notes, 'nonsense').map((n) => n.id),
        sortNotes(notes, DEFAULT_NOTE_SORT_MODE).map((n) => n.id),
    )
    assert.deepEqual(sortNotes(null).map((n) => n.id), [])
})

// ── List edits ──────────────────────────────────────────────────────────────

test('upsertNote replaces by id rather than duplicating', () => {
    const notes = [note({ id: 'a' }), note({ id: 'b' })]
    const replaced = upsertNote(notes, note({ id: 'b', body: 'edited' }))
    assert.equal(replaced.length, 2)
    assert.equal(replaced[1].body, 'edited')

    const added = upsertNote(notes, note({ id: 'c' }))
    assert.deepEqual(added.map((n) => n.id), ['c', 'a', 'b'])
    assert.deepEqual(notes.map((n) => n.id), ['a', 'b'])
})

test('removeNote is a no-op for an unknown id', () => {
    const notes = [note({ id: 'a' }), note({ id: 'b' })]
    assert.deepEqual(removeNote(notes, 'b').map((n) => n.id), ['a'])
    assert.deepEqual(removeNote(notes, 'zzz').map((n) => n.id), ['a', 'b'])
})

test('replaceNoteId swaps a temp id and keeps the note where it was', () => {
    const notes = [note({ id: 'a' }), note({ id: 'tmp_1', body: 'typing' }), note({ id: 'c' })]
    const swapped = replaceNoteId(notes, 'tmp_1', 'note_real', { updatedAt: '2026-08-09T00:00:00Z' })

    assert.deepEqual(swapped.map((n) => n.id), ['a', 'note_real', 'c'])
    assert.equal(swapped[1].body, 'typing')
    assert.equal(swapped[1].updatedAt, '2026-08-09T00:00:00Z')
    assert.deepEqual(replaceNoteId(notes, 'missing', 'x').map((n) => n.id), ['a', 'tmp_1', 'c'])
})

test('editable-field matching identifies stale conflicts without ignoring real edits', () => {
    const local = note({ id: 'same', body: 'ready', status: 'in_progress', priority: 'high', completed: false, todoOrder: 2048 })
    const remote = { ...local, updatedAt: 'newer-server-stamp' }
    assert.equal(noteEditableFieldsMatch(local, remote), true)
    assert.equal(noteEditableFieldsMatch(local, { ...remote, body: 'changed elsewhere' }), false)
    assert.equal(noteEditableFieldsMatch(local, { ...remote, status: 'completed', completed: true }), false)
    assert.equal(noteEditableFieldsMatch(local, { ...remote, tags: ['Review'] }), false)
})

// ── Canvas index ────────────────────────────────────────────────────────────

test('index entries become the count map the canvas gates on', () => {
    const entries = [
        { kind: 'gene', genome_key: GENOME_KEY, target_id: 'ENSG1', count: 3, updated_at: 't' },
        { kind: 'gene', genome_key: `${GENOME_KEY}::dataset::release_116`, target_id: 'ENSG2', count: 1, updated_at: 't' },
        { kind: 'region', genome_key: GENOME_KEY, target_id: 'chr1:1-2', count: 9, updated_at: 't' },
        { kind: 'gene', genome_key: 'ncbi::homo_sapiens::GRCh38', target_id: 'ENSG3', count: 4, updated_at: 't' },
        { kind: 'gene', genome_key: GENOME_KEY, target_id: '', count: 2, updated_at: 't' },
    ]
    const counts = indexEntriesToCountMap(entries, 'gene', GENOME_KEY)

    assert.deepEqual(counts, { ENSG1: 3, ENSG2: 1 })
    assert.equal(hasNotesForGene(counts, 'ENSG1'), true)
    assert.equal(hasNotesForGene(counts, 'ENSG3'), false)
    assert.equal(hasNotesForGene(null, 'ENSG1'), false)
    assert.deepEqual(indexEntriesToCountMap(null), {})
})

test('noteCountsByTarget groups notes by the key they are filed under', () => {
    const counts = noteCountsByTarget([
        note({ id: 'a' }),
        note({ id: 'b' }),
        note({ id: 'c', target: { kind: 'gene', genome_key: GENOME_KEY, id: 'ENSG2' } }),
    ])
    assert.equal(counts[geneNoteTargetKey(GENOME_KEY, 'ENSG1')], 2)
    assert.equal(counts[geneNoteTargetKey(GENOME_KEY, 'ENSG2')], 1)
})

// ── Save state ──────────────────────────────────────────────────────────────

test('a write that nothing edited underneath it reports saved', () => {
    let state = nextSaveState(NOTE_SAVE_STATES.IDLE, 'edit')
    assert.equal(state, NOTE_SAVE_STATES.DIRTY)
    state = nextSaveState(state, 'flush')
    assert.equal(state, NOTE_SAVE_STATES.SAVING)
    state = nextSaveState(state, 'ok')
    assert.equal(state, NOTE_SAVE_STATES.SAVED)
    assert.equal(nextSaveState(state, 'settle'), NOTE_SAVE_STATES.IDLE)
})

test('a keystroke during a write leaves the note dirty, not saved', () => {
    // The whole reason this machine is a tested function: reporting "Saved"
    // here would be reporting it over text that never left the browser.
    let state = nextSaveState(NOTE_SAVE_STATES.SAVING, 'edit')
    assert.equal(state, NOTE_SAVE_STATES.DIRTY)
    assert.equal(nextSaveState(state, 'ok'), NOTE_SAVE_STATES.DIRTY)
})

test('failures and conflicts are sticky until something explicit happens', () => {
    assert.equal(nextSaveState(NOTE_SAVE_STATES.SAVING, 'fail'), NOTE_SAVE_STATES.ERROR)
    assert.equal(nextSaveState(NOTE_SAVE_STATES.SAVING, 'conflict'), NOTE_SAVE_STATES.CONFLICT)
    assert.equal(nextSaveState(NOTE_SAVE_STATES.CONFLICT, 'settle'), NOTE_SAVE_STATES.CONFLICT)
    assert.equal(nextSaveState(NOTE_SAVE_STATES.ERROR, 'settle'), NOTE_SAVE_STATES.ERROR)
    assert.equal(nextSaveState(NOTE_SAVE_STATES.ERROR, 'edit'), NOTE_SAVE_STATES.DIRTY)
    assert.equal(nextSaveState(NOTE_SAVE_STATES.DIRTY, 'unknown-event'), NOTE_SAVE_STATES.DIRTY)
})

test('retry backs off and then holds', () => {
    assert.equal(nextRetryDelayMs(0), 600)
    assert.equal(nextRetryDelayMs(1), 2000)
    assert.equal(nextRetryDelayMs(2), 5000)
    assert.equal(nextRetryDelayMs(99), 5000)
    assert.equal(nextRetryDelayMs(-1), 600)
})

// ── Timestamps ──────────────────────────────────────────────────────────────

test('timestamps read as a time today, a word yesterday, and a date before that', () => {
    const now = new Date(2026, 7, 17, 15, 0, 0).getTime()
    const at = (y, m, d, h = 10, min = 5) => new Date(y, m, d, h, min, 0).toISOString()

    assert.equal(noteTimestampLabel(at(2026, 7, 17, 14, 2), { now }), 'today 14:02')
    assert.equal(noteTimestampLabel(at(2026, 7, 16), { now }), 'yesterday')
    assert.equal(noteTimestampLabel(at(2026, 7, 9), { now }), '9 Aug 2026')
    assert.equal(noteTimestampLabel('', { now }), '')
    assert.equal(noteTimestampLabel('not a date', { now }), '')
})

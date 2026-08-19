// The pure decisions behind the shared note store, plus source invariants for
// the three races that were fixed in this code. The test harness is bare
// `node --test` — no renderer — so the guards that live inside a hook are
// checked by reading the source, in the style of crossViewIsolation.test.js.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
    geneNoteCountsForGenome,
    mergeLoadedNotes,
    notesByTargetKey,
    pendingUnloadWrites,
} from '../src/utils/geneNotes.js'

const HUMAN = 'ensembl::homo_sapiens::GRCh38'
const MOUSE = 'ensembl::mus_musculus::GRCm39'

function note(id, overrides = {}) {
    const { genomeKey = HUMAN, geneId = 'ENSG1', kind = 'gene', ...rest } = overrides
    return {
        id,
        title: '',
        body: `body of ${id}`,
        createdAt: '2026-08-01T09:00:00Z',
        updatedAt: '2026-08-01T09:00:00Z',
        target: { kind, genome_key: genomeKey, id: geneId, label: 'TP53', genome_selection_key: '' },
        ...rest,
    }
}

const byId = (notes) => Object.fromEntries(notes.map((n) => [n.id, n]))

// ── mergeLoadedNotes ────────────────────────────────────────────────────────

test('a load takes the server copy for notes nobody is touching', () => {
    const server = [note('a', { body: 'server a' }), note('b', { body: 'server b' })]
    const local = byId([note('a', { body: 'stale a' }), note('b', { body: 'stale b' })])

    const merged = mergeLoadedNotes(server, local)
    assert.deepEqual(merged.map((n) => n.body), ['server a', 'server b'])
})

test('a note with unsaved edits keeps its text AND its updated_at', () => {
    // The stamp is the compare-and-swap token. Taking the server's would let
    // this pending edit overwrite whatever moved the stamp in the first place.
    const server = [note('a', { body: 'THEIR text', updatedAt: '2026-08-02T00:00:00Z' })]
    const local = byId([note('a', { body: 'MY text', updatedAt: '2026-08-01T09:00:00Z' })])

    const [merged] = mergeLoadedNotes(server, local, { dirtyIds: new Set(['a']) })
    assert.equal(merged.body, 'MY text')
    assert.equal(merged.updatedAt, '2026-08-01T09:00:00Z')
})

test('a note being deleted is not resurrected by a load that still lists it', () => {
    const server = [note('a'), note('b')]
    const local = byId([note('a'), note('b')])

    const merged = mergeLoadedNotes(server, local, { deletingIds: new Set(['a']) })
    assert.deepEqual(merged.map((n) => n.id), ['b'])
})

test('a note still waiting on its POST survives a load that cannot know about it', () => {
    const server = [note('a')]
    const local = byId([note('a'), note('tmp_1', { pending: true, body: 'just typed' })])

    const merged = mergeLoadedNotes(server, local, { dirtyIds: new Set(['tmp_1']) })
    assert.deepEqual(merged.map((n) => n.id).sort(), ['a', 'tmp_1'])
    assert.equal(merged.find((n) => n.id === 'tmp_1').body, 'just typed')
})

test('a local note the server no longer lists is dropped, unless it is pending', () => {
    // Absent from the server means deleted elsewhere — only an uncreated note
    // has a reason to outlive the list it is missing from.
    const local = byId([note('gone'), note('tmp_1', { pending: true })])

    const merged = mergeLoadedNotes([], local)
    assert.deepEqual(merged.map((n) => n.id), ['tmp_1'])
})

test('a dirty note the server dropped does not come back as a ghost', () => {
    const local = byId([note('a', { body: 'edited' })])
    const merged = mergeLoadedNotes([], local, { dirtyIds: new Set(['a']) })
    assert.deepEqual(merged, [])
})

test('mergeLoadedNotes tolerates junk and missing options', () => {
    assert.deepEqual(mergeLoadedNotes(null, null), [])
    assert.deepEqual(mergeLoadedNotes(undefined, {}), [])
    assert.deepEqual(mergeLoadedNotes([note('a')], {}).map((n) => n.id), ['a'])
    assert.deepEqual(mergeLoadedNotes([{ body: 'no id' }], {}), [])
})

// ── pendingUnloadWrites ─────────────────────────────────────────────────────

test('the unload flush writes unsaved notes that actually exist on the server', () => {
    const notes = byId([note('a'), note('b'), note('tmp_1', { pending: true })])
    const dirty = new Set(['a', 'tmp_1', 'vanished'])

    const writes = pendingUnloadWrites(dirty, notes)
    assert.deepEqual(writes.map((n) => n.id), ['a'])
})

test('pendingUnloadWrites copes with nothing to do', () => {
    assert.deepEqual(pendingUnloadWrites(new Set(), {}), [])
    assert.deepEqual(pendingUnloadWrites(null, null), [])
})

// ── Selectors ───────────────────────────────────────────────────────────────

test('notesByTargetKey groups by gene and keeps the order it was given', () => {
    const grouped = notesByTargetKey([
        note('a', { geneId: 'ENSG1' }),
        note('b', { geneId: 'ENSG2' }),
        note('c', { geneId: 'ENSG1' }),
    ])
    const keys = Object.keys(grouped)
    assert.equal(keys.length, 2)
    const first = grouped[keys.find((k) => k.endsWith('ENSG1'))]
    assert.deepEqual(first.map((n) => n.id), ['a', 'c'])
})

test('gene counts are scoped to one assembly and ignore other kinds', () => {
    const notes = [
        note('a', { geneId: 'ENSG1' }),
        note('b', { geneId: 'ENSG1' }),
        note('c', { geneId: 'ENSG2' }),
        note('d', { geneId: 'ENSG1', genomeKey: MOUSE }),
        note('e', { geneId: 'chr1:1-2', kind: 'region' }),
    ]
    assert.deepEqual(geneNoteCountsForGenome(notes, HUMAN), { ENSG1: 2, ENSG2: 1 })
    assert.deepEqual(geneNoteCountsForGenome(notes, MOUSE), { ENSG1: 1 })
})

test('gene counts survive a dataset-suffixed genome key on either side', () => {
    // The panel key carries the release; the note is filed under the assembly.
    // A mismatch here silently loses every bubble, so it gets its own test.
    const notes = [note('a', { genomeKey: `${HUMAN}::dataset::release_116` })]
    assert.deepEqual(geneNoteCountsForGenome(notes, HUMAN), { ENSG1: 1 })
    assert.deepEqual(geneNoteCountsForGenome(notes, `${HUMAN}::dataset::release_117`), { ENSG1: 1 })
    assert.deepEqual(geneNoteCountsForGenome(notes, ''), {})
})

// ── Source invariants ───────────────────────────────────────────────────────
//
// Three races were fixed in this machinery, and none of them can be reproduced
// without a renderer. What can be checked is that the guard is still written
// down, and still in the right order.

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (relative) => readFileSync(join(HERE, '..', 'src', relative), 'utf8')

test('the store keys timers and dirty flags by note id alone', () => {
    // The old keys were `${panelKey}|${noteId}`. A surviving split('|') would
    // leave every unload lookup missing and silently stop saving on quit.
    const source = read('hooks/useNoteStore.jsx')
    assert.ok(!source.includes("split('|')"), 'store still splits a composite key')
    assert.ok(!source.includes('${panelKey}'), 'store still builds a panel-scoped key')
})

test('a note only becomes dirty by being edited', () => {
    // Bug 3: leaving an unedited note used to write to it, moving updated_at and
    // making the next real write conflict with our own. Exactly one place may
    // decide a note is worth writing, and that place is an edit.
    //
    // A create is allowed one more: when the temp id is swapped for the server's,
    // an already-dirty note has to be re-keyed. A failed optimistic bulk delete
    // may also restore a flag it snapshotted before removal. Neither creates new
    // dirty work; both must be visibly guarded by their earlier state.
    const source = read('hooks/useNoteStore.jsx')
    const lines = source.split('\n')
    const marks = lines
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => line.includes('dirtyNotesRef.current.add('))

    assert.ok(marks.length >= 1, 'nothing ever marks a note dirty')

    const inUpdate = marks.filter(({ index }) => {
        const before = lines.slice(0, index).join('\n')
        const start = before.lastIndexOf('const updateNoteFields')
        return start >= 0 && before.indexOf('const deleteNote', start) === -1
            && before.indexOf('const createNote', start) === -1
    })
    assert.equal(inUpdate.length, 1, 'updateNoteFields should be the only place a note becomes dirty')

    for (const { index } of marks) {
        if (inUpdate.some((m) => m.index === index)) continue
        const nearby = lines.slice(Math.max(0, index - 2), index + 1).join('\n')
        assert.ok(
            nearby.includes('dirtyNotesRef.current.delete(') || nearby.includes('dirtyBeforeDelete.has('),
            `line ${index + 1} marks a note dirty without re-keying an existing flag`,
        )
    }
})

test('a write is skipped when the note has nothing unsaved, and never doubles up', () => {
    const source = read('hooks/useNoteStore.jsx')
    assert.ok(source.includes('dirtyNotesRef.current.has('), 'flushNote no longer checks for unsaved edits')
    assert.ok(source.includes('noteWritesInFlightRef.current.get('), 'nothing stops two writes racing')
    assert.ok(source.includes('noteVersionsRef.current.get('), 'the CAS token is not read from the ref')
})

test('a load in flight is retired before optimistic state is written', () => {
    // Bug 1: a GET issued before a create landed afterwards and dropped it.
    const source = read('hooks/useNoteStore.jsx')
    for (const fn of ['const createNote', 'const deleteNote']) {
        const start = source.indexOf(fn)
        assert.ok(start >= 0, `${fn} not found`)
        const body = source.slice(start, source.indexOf('\n    }, [', start))
        const invalidateAt = body.indexOf('invalidateLoad()')
        const writeAt = body.indexOf('setNotesById')
        assert.ok(invalidateAt >= 0, `${fn} does not retire in-flight loads`)
        assert.ok(writeAt >= 0, `${fn} does not write state`)
        assert.ok(invalidateAt < writeAt, `${fn} retires loads after writing state, not before`)
    }
})

test('a landing load is merged, never assigned wholesale', () => {
    const source = read('hooks/useNoteStore.jsx')
    assert.ok(source.includes('mergeLoadedNotes('), 'the load path does not protect local work')
})

test('there is exactly one note store context', () => {
    // Two instances would mean two CAS token caches, which is the false
    // "Changed elsewhere" bug again at a different scope.
    const source = read('hooks/useNoteStore.jsx')
    assert.equal((source.match(/createContext\(/g) || []).length, 1)
    assert.ok(/throw new Error/.test(source), 'useNoteStore should throw without a provider')
})

test('leaving a note tells a temp id apart from a real one', () => {
    // Bug 2: the temp→server id swap read as "the reader left this note", which
    // ran the blank-note discard over a note they had just created.
    const source = read('hooks/useSaveOnLeaveNote.js')
    assert.ok(source.includes('isTempNoteId'), 'the leave hook lost its temp-id guard')
    assert.equal((source.match(/isTempNoteId\(/g) || []).length >= 2, true,
        'both the change effect and the unmount cleanup need the guard')
})

test('deleting a note while its create is pending removes the eventual server copy', () => {
    const source = read('hooks/useNoteStore.jsx')
    assert.ok(source.includes('pendingCreateDeletesRef.current.add(noteId)'),
        'pending note deletion is not remembered')
    assert.ok(source.includes('pendingCreateDeletesRef.current.delete(tempId)'),
        'the arriving create does not consume the deletion request')
    assert.match(source, /api\/notes\/\$\{encodeURIComponent\(created\.id\)\}/,
        'the assigned server note is not deleted')
})

test('the genome drawer leaves note editing cleanly and clears transcript pins', () => {
    const drawer = read('components/FocusNotesPanel.jsx')
    const browser = read('components/GenomeBrowserView.jsx')
    assert.ok(drawer.includes('if (noteIsBlank(note))'),
        'blank notes still pass through confirmation')
    assert.ok(browser.includes('const handleNoteDelete'),
        'the genome browser has no drawer-aware delete handler')
    assert.match(browser, /setNotesPanelOpenByPanel\([\s\S]*?\[panelKey\]: false/,
        'deleting a note does not close the secondary notes panel')
    assert.match(browser, /handleFocusTranscriptViewChange\(panelKey, \{[\s\S]*?pinnedId: null/,
        'creating a note does not release the highlighted transcript')
})

// Guards that live inside the transfer dialog rather than in a pure module.
//
// The harness is bare `node --test` with no renderer, so the things that must be
// true about the component are checked by reading its source — same approach as
// noteStore.test.js. These are cheap tripwires for the invariants that would be
// silently expensive to lose.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const modal = readFileSync(new URL('../src/components/NotesTransferModal.jsx', import.meta.url), 'utf8')
const tree = readFileSync(new URL('../src/components/NotesTransferTree.jsx', import.meta.url), 'utf8')
const view = readFileSync(new URL('../src/components/NotesView.jsx', import.meta.url), 'utf8')

test('the dialog gets its rules from the model rather than reimplementing them', () => {
    assert.match(modal, /from '\.\.\/utils\/notesTransferModel'/)
    for (const name of ['buildTransferTree', 'computeSelectionStates', 'toggleNode', 'selectionSummary']) {
        assert.ok(modal.includes(name), `${name} should come from the model`)
    }
})

test('tri-state lives in the tree component and nowhere else', () => {
    assert.match(tree, /indeterminate = state === 'partial'/)
    assert.ok(!modal.includes('indeterminate'), 'the modal should not hand-roll a tri-state box')
})

test('the tree component holds no selection logic of its own', () => {
    assert.ok(!tree.includes('new Set('), 'selection sets belong to the model and the modal')
    assert.match(tree, /from '\.\.\/utils\/notesTransferModel'/)
})

test('importing is impossible without a scan, because Apply needs the scan digest', () => {
    assert.match(modal, /if \(!scan\?\.digest \|\| applying\) return/)
    assert.match(modal, /disabled=\{applying \|\| !scan\?\.digest/)
})

test('apply sends the digests the scan reported', () => {
    const applyBody = modal.slice(modal.indexOf('/api/notes/import/apply'))
    assert.match(applyBody, /digest: scan\.digest/)
    assert.match(applyBody, /store_digest: scan\.store_digest/)
})

test('a file that changed after the scan re-scans instead of applying', () => {
    assert.match(modal, /res\.status === 409[\s\S]{0,400}runScan\(scan\.path\)/)
})

test('the destructive strategy is behind a second confirm', () => {
    assert.match(modal, /if \(strategyMeta\?\.destructive\) setConfirmingDestructive\(true\)/)
    assert.match(modal, /confirmingDestructive \?/)
})

test('the export dialog admits when a selection is hidden by the filters', () => {
    assert.match(modal, /summary\.hiddenSelectedCount > 0/)
})

test('"Selected only" is one of the filter options, not a separate chip', () => {
    assert.ok(!modal.includes('selectedOnly'), 'no bespoke state beside the note-set filter')
    assert.match(modal, /TRANSFER_NOTE_SETS\.map/)
    assert.match(modal, /option\.requiresSelection && selectedIds\.size === 0/)
    assert.match(modal, /disabled=\{locked\}/)
})

test('"Selected only" hands back once the selection is emptied', () => {
    assert.match(modal, /noteSet === 'selected' && selectedIds\.size === 0[\s\S]{0,60}setNoteSet\(DEFAULT_TRANSFER_NOTE_SET\)/)
})

test('the tree starts fully collapsed with nothing selected', () => {
    assert.match(modal, /useState\(\(\) => new Set\(\)\)/)
    assert.ok(!modal.includes("new Set(['group:todo'"), 'no branch is open by default')
})

test('choosing a tag selects what it matches and opens the tree onto it', () => {
    assert.match(modal, /noteIdsForTagSelection/)
    assert.match(modal, /setSelectedIds\(new Set\(matched\)\)/)
    assert.match(modal, /setExpanded\(new Set\(allExpandableNodeIds\(matchedTree\)\)\)/)
})

test('changing the match mode re-selects, so all/any is not just cosmetic', () => {
    assert.match(modal, /handleTagMatchMode[\s\S]{0,300}setSelectedIds\(new Set\(noteIdsForTagSelection/)
})

test('the match toggle keeps its space so the rows below never jump', () => {
    assert.match(modal, /selectedTags\.length > 1 \? '' : 'invisible'/)
})

test('the search box offers a clear button once there is text', () => {
    assert.match(modal, /aria-label="Clear search"/)
    assert.match(modal, /onClick=\{\(\) => setQuery\(''\)\}/)
})

test('the hidden-notes warning clears the filters itself', () => {
    assert.match(modal, /onClick=\{clearFilters\}[\s\S]{0,120}clear the filters/)
    assert.match(modal, /const clearFilters[\s\S]{0,200}setQuery\(''\)[\s\S]{0,120}setSelectedTags\(\[\]\)[\s\S]{0,80}setNoteSet\('both'\)/)
})

test('export and import are separate dialogs, each sized for its own job', () => {
    // No in-dialog tab switcher: the Notes toolbar opens the one that was asked for.
    assert.ok(!/setTab\(/.test(modal), 'the tab switcher was replaced by a mode prop')
    assert.match(modal, /const isExport = mode !== 'import'/)
    assert.match(modal, /isExport[\s\S]{0,80}max-w-6xl[\s\S]{0,80}max-w-2xl/)
})

test('the spreadsheet caveat is shown for the lossy formats only', () => {
    assert.match(modal, /chosenFormat && !chosenFormat\.lossless \? <span>\{SPREADSHEET_CAVEAT\}/)
})

test('an existing export file offers replace rather than clobbering silently', () => {
    assert.match(modal, /res\.status === 409[\s\S]{0,200}setOverwritePrompt\(true\)/)
    assert.match(modal, /runExport\('overwrite'\)/)
})

test('the notes view opens the dialog and reloads the store after an import', () => {
    assert.match(view, /import NotesTransferModal from '\.\/NotesTransferModal'/)
    assert.match(view, /onImported=\{\(\) => store\.reload\(\)\}/)
    assert.match(view, /setTransferTab\('export'\)/)
})

test('a finished export closes the dialog and reports from outside it', () => {
    const body = modal.slice(modal.indexOf('/api/notes/export'))
    assert.ok(/onNotify\?\.\([\s\S]{0,600}onClose\?\.\(\)/.test(body), 'notify then close')
})

test('a finished import closes the dialog and reports from outside it', () => {
    const body = modal.slice(modal.indexOf('/api/notes/import/apply'))
    assert.ok(body.includes('onImported?.()'), 'the store is reloaded')
    assert.ok(/onNotify\?\.\([\s\S]{0,700}onClose\?\.\(\)/.test(body), 'notify then close')
})

test('a failure keeps the dialog open so it can still be fixed', () => {
    // Only the success paths close. Errors stay put next to the thing that
    // caused them.
    const closes = modal.match(/onClose\?\.\(\)/g) || []
    const notifies = modal.match(/onNotify\?\.\(/g) || []
    assert.equal(notifies.length, 2, 'one notification each for export and import')
    assert.ok(closes.length >= 2)
    assert.ok(!/setExportMessage\(\{\s*ok: true/.test(modal), 'no success box left behind in the dialog')
    assert.ok(!/setImportMessage\(\{\s*ok: true/.test(modal), 'same for import')
})

test('the toast matches the app pattern: bottom-centre, tone-coloured, self-dismissing', () => {
    assert.match(view, /transferNotice/)
    assert.match(view, /fixed bottom-6 left-1\/2/)
    assert.match(view, /border-green-300[\s\S]{0,160}border-red-300/)
    assert.match(view, /setTimeout\(\(\) => setTransferNotice\(null\), 6000\)/)
    assert.match(view, /onNotify=\{\(notice\) => setTransferNotice/)
})

test('the notes toolbar offers export and import as separate buttons', () => {
    assert.match(view, /setTransferTab\('export'\)/)
    assert.match(view, /setTransferTab\('import'\)/)
    assert.match(view, /mode=\{transferTab \|\| 'export'\}/)
})

test('the dialog is handed archived notes as well as active ones', () => {
    // allStoredNotes is store.notes plus store.archivedNotes; passing only the
    // current set would make an export silently partial.
    assert.match(view, /notes=\{allStoredNotes\}/)
})

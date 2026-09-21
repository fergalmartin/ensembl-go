import test from 'node:test'
import assert from 'node:assert/strict'

import {
    SELECTION_BAR_HEIGHT,
    SELECTION_COPY_MAX_BP,
    SELECT_DRAG,
    SELECT_ENDS,
    SELECT_MODES,
    columnAtX,
    gapToBand,
    isPointSelection,
    isSelectMode,
    selectModeLabel,
    selectionActions,
    selectionBarPlacement,
    selectionLength,
    selectionRange,
    selectionTopGap,
} from '../src/utils/sequenceViewSelect.js'

test('there are two ways of drawing a selection, and only those two', () => {
    assert.deepEqual(SELECT_MODES.map((mode) => mode.id), [SELECT_DRAG, SELECT_ENDS])
    assert.equal(isSelectMode(SELECT_DRAG), true)
    assert.equal(isSelectMode(SELECT_ENDS), true)
    assert.equal(isSelectMode('lasso'), false)
    // An unknown mode reads as the drag, which is what the tool did before it
    // had a choice of ways.
    assert.equal(selectModeLabel('lasso'), 'Drag')
    assert.equal(selectModeLabel(SELECT_ENDS), 'Two clicks')
})

test('a selection is a range whichever end it was drawn from', () => {
    assert.deepEqual(selectionRange({ start: 10, end: 40 }), { start: 10, end: 40 })
    assert.deepEqual(selectionRange({ start: 40, end: 10 }), { start: 10, end: 40 })
    assert.equal(selectionLength({ start: 10, end: 40 }), 31, 'both ends are in it')
    assert.equal(selectionLength({ start: 7, end: 7 }), 1)
})

test('anything that is not a pair of coordinates is not a selection', () => {
    for (const bad of [null, undefined, {}, { start: 1 }, { start: 1, end: null }, { start: 'x', end: 4 }]) {
        assert.equal(selectionRange(bad), null)
        assert.equal(selectionLength(bad), 0)
    }
})

test('one base is a click rather than a range', () => {
    assert.equal(isPointSelection({ start: 5, end: 5 }), true)
    assert.equal(isPointSelection({ start: 5, end: 6 }), false)
    // Half a two-click selection, before the second click lands.
    assert.equal(selectionActions({ start: 5, end: 5 }).canFocus, false)
})

test('a selection knows what may be done with it', () => {
    const small = selectionActions({ start: 100, end: 200 })
    assert.equal(small.bases, 101)
    assert.equal(small.canFocus, true)
    assert.equal(small.canCopy, true)
    assert.equal(small.canBrowse, true)
    assert.equal(small.copyRefusal, '')
})

test('a selection too big for the clipboard says so before it is pressed', () => {
    const huge = selectionActions({ start: 1, end: SELECTION_COPY_MAX_BP + 1 })
    assert.equal(huge.canCopy, false, 'offered and then refused is worse than not offered')
    assert.ok(huge.copyRefusal.includes('Download'), 'and says where to go instead')
    // Everything else still works at that size: it is the clipboard that has
    // the limit, not the region.
    assert.equal(huge.canFocus, true)
    assert.equal(huge.canBrowse, true)
    // Exactly at the limit is within it.
    assert.equal(selectionActions({ start: 1, end: SELECTION_COPY_MAX_BP }).canCopy, true)
})

test('nothing is offered for a selection that does not exist', () => {
    const none = selectionActions(null)
    assert.equal(none.range, null)
    assert.equal(none.canCopy, false)
    assert.equal(none.canBrowse, false)
    assert.equal(none.canFocus, false)
})

const rows = { rowHeight: 26 }
const place = (firstRow, lastRow, scrollTop, viewportPx = 600, gap = 0) => selectionBarPlacement({
    firstRowTop: gap + firstRow * rows.rowHeight,
    lastRowBottom: gap + (lastRow + 1) * rows.rowHeight,
    scrollTop,
    viewportPx,
})

test('the bar sits above the first row of the selection', () => {
    // Rows 10 to 20, with the screen showing from row 8 down.
    const at = place(10, 20, 8 * rows.rowHeight)
    assert.equal(at.top, 10 * rows.rowHeight - SELECTION_BAR_HEIGHT)
    assert.equal(at.visible, true)
})

test('scrolling into the selection pins the bar to the top of the screen', () => {
    // The reader is now well inside a selection whose top is far above them.
    const at = place(10, 400, 200 * rows.rowHeight)
    assert.equal(at.top, 200 * rows.rowHeight, 'held at the top of the screen')
    assert.equal(at.visible, true)
})

test('the bar stops at the end of the selection rather than running on', () => {
    // Scrolled past the whole thing: there is nothing below for it to label, so
    // it goes off the bottom with the rows it belongs to.
    const at = place(10, 20, 100 * rows.rowHeight)
    assert.equal(at.top, 21 * rows.rowHeight - SELECTION_BAR_HEIGHT)
    assert.equal(at.visible, false, 'and is not drawn once it has gone')
})

test('a selection below the screen has no bar on it yet', () => {
    const at = place(300, 400, 0, 600)
    assert.equal(at.visible, false)
})

test('a short selection near the top still gets its bar above it', () => {
    // One row, at row 5, read from the top of the document.
    const at = place(5, 5, 0)
    assert.equal(at.top, 5 * rows.rowHeight - SELECTION_BAR_HEIGHT)
    assert.equal(at.visible, true)
})

test('the first rows of the document are pushed down to make room', () => {
    // Nowhere above row 0 for a bar to go, so the sequence makes room. Anywhere
    // else the row above belongs to somebody else and may simply be covered.
    assert.equal(selectionTopGap(0), SELECTION_BAR_HEIGHT)
    assert.equal(selectionTopGap(1), SELECTION_BAR_HEIGHT)
    assert.equal(selectionTopGap(2), 0)
    assert.equal(selectionTopGap(4000), 0)
    assert.equal(selectionTopGap(null), 0)
    // And with that room made, the bar lands in it rather than over the bases.
    const at = place(0, 30, 0, 600, SELECTION_BAR_HEIGHT)
    assert.equal(at.top, 0)
    assert.equal(at.visible, true)
})

test('a placement it cannot work out is no placement at all', () => {
    assert.equal(selectionBarPlacement({}), null)
    assert.equal(selectionBarPlacement({ firstRowTop: 10 }), null)
    assert.equal(selectionBarPlacement(), null)
})

test('the bar is about two rows of sequence tall', () => {
    assert.ok(SELECTION_BAR_HEIGHT >= 2 * rows.rowHeight - 12)
    assert.ok(SELECTION_BAR_HEIGHT <= 2 * rows.rowHeight + 12)
})

test('a press beside the bases lands on the nearest one', () => {
    const band = { left: 100, right: 700, count: 60 }   // ten pixels a base
    assert.equal(columnAtX(100, band), 0)
    assert.equal(columnAtX(105, band), 0)
    assert.equal(columnAtX(115, band), 1)
    assert.equal(columnAtX(695, band), 59)
    // The coordinate margins are not sequence, but a press on one plainly means
    // the end of the row beside it rather than nothing at all.
    assert.equal(columnAtX(20, band), 0, 'left margin')
    assert.equal(columnAtX(900, band), 59, 'right margin')
    assert.equal(columnAtX(700, band), 59, 'the far edge is the last base')
})

test('a band that is not a band places nothing', () => {
    assert.equal(columnAtX(150, { left: 100, right: 700, count: 0 }), null)
    assert.equal(columnAtX(150, { left: 700, right: 100, count: 60 }), null)
    assert.equal(columnAtX(null, { left: 100, right: 700, count: 60 }), null)
    assert.equal(columnAtX(150, {}), null)
})

test('the row nearest a press is the one it is least outside of', () => {
    assert.equal(gapToBand(150, 100, 200), 0, 'inside')
    assert.equal(gapToBand(100, 100, 200), 0, 'its own edges are inside')
    assert.equal(gapToBand(96, 100, 200), 4, 'just above')
    assert.equal(gapToBand(203, 100, 200), 3, 'just below')
    assert.equal(gapToBand(null, 100, 200), Infinity)
})

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
    barAlongRow,
    rowToCentre,
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


// ---- pointing the bar at what it is about ---------------------------------

// A row block a thousand pixels wide, and a bar three hundred of them.
const ROW = 1000
const BAR = 300

test('the bar starts where the match starts, where there is room', () => {
    assert.equal(barAlongRow({ matchLeft: 100, matchRight: 160, barWidth: BAR, rowWidth: ROW }), 100)
    assert.equal(barAlongRow({ matchLeft: 0, matchRight: 40, barWidth: BAR, rowWidth: ROW }), 0)
})

test('too far along to start there, it centres over the match instead', () => {
    // Starting at 800 would put its right edge at 1100, off the end.
    const at = barAlongRow({ matchLeft: 800, matchRight: 860, barWidth: BAR, rowWidth: ROW })
    assert.equal(at, Math.round((800 + 860) / 2 - BAR / 2))
    assert.ok(at + BAR <= ROW, 'and it is wholly inside the row')
})

test('too far along even to centre, the right edges go level', () => {
    const at = barAlongRow({ matchLeft: 960, matchRight: 1000, barWidth: BAR, rowWidth: ROW })
    assert.equal(at, 1000 - BAR, 'its right edge on the match’s right edge')
    assert.ok(at + BAR <= ROW)
})

test('a match at the very start cannot centre or right-align outside the row', () => {
    // Centring on a match at the left edge would want a negative offset, and
    // right-aligning would want a more negative one; the left edge wins.
    assert.equal(barAlongRow({ matchLeft: 0, matchRight: 20, barWidth: BAR, rowWidth: ROW }), 0)
})

test('nothing ever leaves the row, whatever the numbers say', () => {
    for (const [left, right] of [[-500, -400], [1200, 1400], [0, 5000]]) {
        const at = barAlongRow({ matchLeft: left, matchRight: right, barWidth: BAR, rowWidth: ROW })
        assert.ok(at >= 0 && at + BAR <= ROW, `${left}-${right} stayed inside`)
    }
})

test('a bar wider than the row starts at the beginning of it', () => {
    assert.equal(barAlongRow({ matchLeft: 400, matchRight: 460, barWidth: 1200, rowWidth: ROW }), 0)
})

test('nonsense places nothing rather than placing it somewhere wrong', () => {
    assert.equal(barAlongRow({}), null)
    assert.equal(barAlongRow({ matchLeft: 1, matchRight: 2, barWidth: 3 }), null)
})

// ---- putting a row in the middle ------------------------------------------

test('a row is centred by putting half a screen above it', () => {
    assert.equal(rowToCentre(100, 21), 90)
    assert.equal(rowToCentre(100, 20), 90.5, 'fractional, so a caller can round once')
})

test('a row near the top of the document goes as high as it can and no higher', () => {
    assert.equal(rowToCentre(3, 21), 0, 'not a negative scroll')
    assert.equal(rowToCentre(0, 21), 0)
})

test('a screen of one row is that row', () => {
    assert.equal(rowToCentre(40, 1), 40)
    assert.equal(rowToCentre(40, 0), 40, 'and an unmeasured screen moves nothing')
})

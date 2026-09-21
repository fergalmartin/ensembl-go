// Selecting a stretch of sequence: the two ways of drawing one, and what a
// finished one can be used for.
//
// Kept out of the canvas because the gesture has state that outlives a single
// event -- a two-click selection is half made between its clicks -- and because
// what the panel over a finished selection may offer depends on how big it is,
// which is arithmetic rather than drawing.

/** Dragged from one end to the other, as every other view in the app does it. */
export const SELECT_DRAG = 'drag'

/** Click the first base, then the last. */
export const SELECT_ENDS = 'ends'

export const SELECT_MODES = Object.freeze([
    {
        id: SELECT_DRAG,
        label: 'Drag',
        hint: 'Press on the first base and drag to the last.',
    },
    {
        id: SELECT_ENDS,
        label: 'Two clicks',
        hint: 'Click the first base, then the last. The page is yours in between, '
            + 'so a selection can be longer than a screen without holding the button down.',
    },
])

export function selectModeLabel(mode) {
    return (SELECT_MODES.find((item) => item.id === mode) || SELECT_MODES[0]).label
}

export function isSelectMode(mode) {
    return SELECT_MODES.some((item) => item.id === mode)
}

/**
 * The most a selection can be and still be worth putting on the clipboard.
 *
 * The backend refuses past twenty megabases and says so, which is the honest
 * limit; this is the smaller number the bar uses to decide whether to offer
 * copying at all, because a reader who presses Copy should not be told
 * afterwards that they could not have.
 */
export const SELECTION_COPY_MAX_BP = 2_000_000

/**
 * How tall the bar over a selection is drawn.
 *
 * About two rows of sequence: enough for the region's name over a row of
 * controls, and little enough that it reads as a label on the selection rather
 * than as a panel that has landed on top of it.
 */
export const SELECTION_BAR_HEIGHT = 46

function num(value) {
    if (value === null || value === undefined || value === '') return null
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
}

/** A selection as an ordered range, or null for anything that is not one. */
export function selectionRange(selection) {
    const from = num(selection?.start)
    const to = num(selection?.end)
    if (from === null || to === null) return null
    return { start: Math.min(from, to), end: Math.max(from, to) }
}

export function selectionLength(selection) {
    const range = selectionRange(selection)
    return range ? range.end - range.start + 1 : 0
}

/** Whether a selection is one base, which is a click rather than a range. */
export function isPointSelection(selection) {
    return selectionLength(selection) === 1
}

/** What the bar over a selection may offer, given how big it is. */
export function selectionActions(selection) {
    const range = selectionRange(selection)
    const bases = selectionLength(selection)
    return {
        range,
        bases,
        // Focusing on one base would be a window of one, which is not a region.
        canFocus: bases > 1,
        canCopy: bases > 0 && bases <= SELECTION_COPY_MAX_BP,
        canBrowse: bases > 0,
        copyRefusal: bases > SELECTION_COPY_MAX_BP
            ? `${bases.toLocaleString()} bases is more than the clipboard should be given. `
                + 'Download it from the panel instead.'
            : '',
    }
}

/**
 * Where the bar over a selection sits, in the scroller's own coordinates.
 *
 * Above the selection's first row, and pinned to the top of the screen once the
 * reader has scrolled down past that row -- so it stays with them through a
 * selection longer than the screen instead of being left behind at the top of
 * it. It stops at the selection's last row: past the end of the region there is
 * nothing for it to be a bar for, and it goes off the bottom with the rows it
 * belongs to.
 *
 * Every number is a position inside the scrolling content, which is what the
 * rows are placed in too: `scrollTop` is where the screen currently starts, and
 * a row's top is where that row sits in the whole document.
 */
export function selectionBarPlacement({
    firstRowTop,
    lastRowBottom,
    scrollTop = 0,
    viewportPx = 0,
    barHeight = SELECTION_BAR_HEIGHT,
} = {}) {
    const top = num(firstRowTop)
    const bottom = num(lastRowBottom)
    if (top === null || bottom === null) return null
    const at = num(scrollTop) ?? 0
    const height = num(viewportPx) ?? 0

    // Above the first row, then held at the top of the screen, then stopped at
    // the far end of the selection.
    let y = Math.max(top - barHeight, at)
    y = Math.min(y, Math.max(top - barHeight, bottom - barHeight))

    // Off the screen either way means there is nothing to draw: the reader is
    // somewhere else in the document entirely.
    const visible = height <= 0 || (y + barHeight > at && y < at + height)
    return { top: Math.round(y), visible }
}

/**
 * Whether the rows need pushing down to make room for the bar.
 *
 * Only where there is nowhere else for it to go: a selection starting on the
 * document's first row has no row above it to sit over, and a bar laid across
 * the top of the sequence would hide the very bases it is a bar for. Anywhere
 * else the row above is somebody else's sequence, which the bar may cover while
 * it is needed, so the rows stay where they are.
 */
export function selectionTopGap(firstRow, barHeight = SELECTION_BAR_HEIGHT) {
    const row = num(firstRow)
    if (row === null || row > 1) return 0
    return barHeight
}

/**
 * Which base along a row a horizontal position falls on.
 *
 * A row is a band of equal cells between the two coordinate margins, so the
 * column is arithmetic rather than a hit test -- which is the point: this is
 * asked when the press did not land on a cell at all. Left of the bases is the
 * first of them and right of them is the last, so pressing on the margin, or in
 * the hair's breadth between two rows, starts the selection where the reader
 * plainly meant it to rather than not starting it at all.
 */
export function columnAtX(x, { left, right, count } = {}) {
    const at = num(x)
    const from = num(left)
    const to = num(right)
    const cells = Math.floor(num(count) ?? 0)
    if (at === null || from === null || to === null || cells <= 0 || to <= from) return null
    if (at <= from) return 0
    if (at >= to) return cells - 1
    const width = (to - from) / cells
    return Math.min(cells - 1, Math.max(0, Math.floor((at - from) / width)))
}

/**
 * How far a point is from a band, vertically: zero inside it.
 *
 * What picks the row nearest a press that landed between two of them.
 */
export function gapToBand(y, top, bottom) {
    const at = num(y)
    const from = num(top)
    const to = num(bottom)
    if (at === null || from === null || to === null) return Infinity
    if (at < from) return from - at
    if (at > to) return at - to
    return 0
}

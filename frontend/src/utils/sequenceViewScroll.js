// The virtual scroller's arithmetic: how a scroll position becomes a row, and
// back again.
//
// A focus region can be a whole chromosome. Human chr1 is 248,956,422 bases,
// which is 4,149,274 rows of 60, which at 26 px a row is 107.9 million pixels of
// content — several times what a browser will let an element be tall. So the
// spacer is capped, and row positions are a proportion of it rather than a
// multiplication.
//
// The cap costs nothing in the normal case. Below MAX_SCROLL_PX / rowHeight
// rows — around 27 Mb of sequence at the default row height — the spacer is the
// true content height and `scrollTopForRow` reduces exactly to `row * rowHeight`.
// Every focus level except a whole-chromosome location is in that range; the
// largest human gene is 2.5 Mb, which is under a tenth of it. Compression is an
// edge case, and `wheelTargetRow` is what keeps that edge case readable.
//
// Rows are not all the same height any more: a row carrying a protein lane is
// taller than one that does not. Everything here is therefore expressed through
// a *height index* (utils/sequenceViewHeights.js), which answers where a row
// begins and which row is at a pixel. With no lanes that index is a multiply and
// a divide, so every line below reduces to exactly the arithmetic it was — the
// compressed path included, which is tested against the formula it replaced.
//
// The two features cannot meet in any case: a lane needs a single reading frame,
// which means a transcript or a feature in focus, and the largest of those is
// two and a half megabases against the twenty-seven a compressed spacer starts
// at.

import { createHeightIndex } from './sequenceViewHeights.js'

export const MAX_SCROLL_PX = 12_000_000

function positive(value, fallback = 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function clamp(value, low, high) {
    if (!Number.isFinite(value)) return low
    return Math.min(high, Math.max(low, value))
}

/**
 * Everything the scroller needs to place a row, derived once per geometry.
 *
 * `maxAnchorRow` is the row that sits at the top when the scroller is at the
 * bottom — a fraction, because the last screenful rarely divides evenly. Both
 * mappings are expressed against it, which is what makes the round trip exact
 * and the last row exactly reachable.
 */
export function createScrollModel({
    totalRows = 0,
    rowHeight = 0,
    viewportPx = 0,
    laneHeight = 0,
    laneRows = null,
} = {}) {
    const rows = Math.max(0, Math.floor(Number(totalRows) || 0))
    const height = positive(rowHeight, 1)
    const viewport = positive(viewportPx, 0)
    const heights = createHeightIndex({
        totalRows: rows, rowHeight: height, laneHeight, runs: laneRows,
    })

    const contentPx = heights.contentPx
    const spacerPx = Math.min(contentPx, MAX_SCROLL_PX)
    const maxScrollTop = Math.max(0, spacerPx - viewport)
    // The row at the top when the scroller is at the bottom: whichever row the
    // last viewport's worth of content begins in. With uniform rows this is
    // `rows - viewport / height` exactly, which is what it used to say.
    const maxAnchorRow = heights.rowAtOffset(Math.max(0, contentPx - viewport))

    return {
        totalRows: rows,
        rowHeight: height,
        viewportPx: viewport,
        heights,
        contentPx,
        spacerPx,
        maxScrollTop,
        maxAnchorRow,
        // How many rows one pixel of scrolling covers beyond the honest 1:1.
        // 1 means the spacer is the true content height.
        compression: spacerPx > 0 ? contentPx / spacerPx : 1,
    }
}

/** How tall one row is drawn. */
export function rowHeightAt(model, row) {
    return model?.heights ? model.heights.heightOfRow(row) : (model?.rowHeight || 0)
}

/** Whether a row carries the extra lane, which is also what decides its height. */
export function rowHasLane(model, row) {
    return Boolean(model?.heights?.isTall(row))
}

/** The pixel a scroll position stands for, before the spacer's compression. */
function contentOffsetAt(model, scrollTop) {
    const at = clamp(Number(scrollTop) || 0, 0, model.maxScrollTop)
    if (model.compression === 1) return at
    // Compressed, the spacer is a proportion of the content rather than the
    // content, so a scroll position is read as a fraction of the travel.
    const travel = Math.max(0, model.contentPx - model.viewportPx)
    return model.maxScrollTop > 0 ? (at / model.maxScrollTop) * travel : 0
}

/**
 * The row at the top of the viewport, as a fraction.
 *
 * Fractional on purpose. Under compression many scroll positions map into the
 * same row, and flooring here would make the sequence stick for a few pixels
 * and then jump a whole row.
 */
export function rowAtScrollTop(model, scrollTop) {
    if (!model || model.maxScrollTop <= 0) return 0
    return model.heights.rowAtOffset(contentOffsetAt(model, scrollTop))
}

/** Where to scroll so that `row` is at the top of the viewport. */
export function scrollTopForRow(model, row) {
    if (!model || model.maxAnchorRow <= 0) return 0
    const at = clamp(Number(row) || 0, 0, model.maxAnchorRow)
    const offset = model.heights.offsetOfRow(at)
    if (model.compression === 1) return offset
    const travel = Math.max(0, model.contentPx - model.viewportPx)
    return travel > 0 ? (offset / travel) * model.maxScrollTop : 0
}

/**
 * The rows to mount, and where to put the slab that holds them.
 *
 * The slab is absolutely positioned inside the scrolling element, so it travels
 * with the content and its offset has to include `scrollTop`. That indirection
 * is the price of the capped spacer: the slab's position is not derivable from
 * the spacer the way it would be in an ordinary virtual list.
 */
export function visibleRowRange(model, scrollTop, overscan = 2) {
    if (!model || model.totalRows <= 0) {
        return { firstRow: 0, count: 0, anchorRow: 0, slabTopPx: 0 }
    }
    const pad = Math.max(0, Math.floor(Number(overscan) || 0))
    const anchorRow = rowAtScrollTop(model, scrollTop)
    // The base height is the shortest a row can be, so this is an upper bound on
    // how many fit -- which is what it has to be. A lane on screen means fewer
    // rows fit and a couple more are mounted than are needed, which costs less
    // than a row of the sequence not being there.
    const onScreen = Math.ceil(model.viewportPx / model.rowHeight) + 1
    const firstRow = Math.max(0, Math.floor(anchorRow) - pad)
    const count = Math.min(model.totalRows - firstRow, onScreen + pad * 2)
    const at = clamp(Number(scrollTop) || 0, 0, model.maxScrollTop)
    // How far back the slab starts from the anchor, in real pixels rather than
    // in rows -- the rows between them need not be the same height.
    const back = model.heights.offsetOfRow(anchorRow) - model.heights.offsetOfRow(firstRow)
    return {
        firstRow,
        count: Math.max(0, count),
        anchorRow,
        slabTopPx: at - back,
    }
}

/**
 * Where a wheel notch should land, in rows.
 *
 * A wheel delta is a distance in pixels the reader expects the *content* to
 * move. Handing it to the scroll position directly would multiply it by the
 * compression: on chr1 a 100 px notch would jump some 35 rows, over two
 * kilobases, and fine reading would be impossible. So the wheel is translated
 * into rows and the scroll position derived from that. Dragging the scrollbar
 * still traverses the whole region, which is what a scrollbar is for.
 */
export function wheelTargetRow(model, anchorRow, deltaY) {
    if (!model || model.maxAnchorRow <= 0) return 0
    const from = clamp(Number(anchorRow) || 0, 0, model.maxAnchorRow)
    // The delta is a distance the content should travel, so it is added in
    // pixels and turned back into a row -- which with rows of two heights is not
    // the same as dividing it by one of them.
    const to = model.heights.rowAtOffset(model.heights.offsetOfRow(from) + (Number(deltaY) || 0))
    return clamp(to, 0, model.maxAnchorRow)
}

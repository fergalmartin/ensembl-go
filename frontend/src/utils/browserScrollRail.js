// The genome browser's own scroll bar: the vertical rail down the left-hand
// gutter, carrying a coloured dot per active genome and a ring showing where the
// page currently is.
//
// The dots are not decoration. A dot sits at exactly the scroll position that
// parks its genome's control bar against the app's top bar — the same position
// the Cycle wheel's Jump scrolls to — so the ring coming to rest on a dot and
// the genome arriving at the top are the same event, not two things that have to
// be kept in step.
//
// Everything that reads the page's geometry lives here, shared with the browser
// view, so the rail and the Cycle wheel's alignment can never disagree about
// where a genome begins.

// The app's scroll container. Deliberately does *not* insist the content already
// overflows: the whitespace under the last panel exists precisely to create that
// overflow, so the question is which element owns the scroll, not whether it has
// anything to scroll yet.
export function findScrollHost(from) {
    let node = from
    while (node && node !== document.body) {
        const overflowY = window.getComputedStyle(node).overflowY
        if (overflowY === 'auto' || overflowY === 'scroll') return node
        node = node.parentElement
    }
    return null
}

// How much of the top of the page the general control bar is covering. Zero
// while it is locked into the page; once unlocked it floats over the top of the
// scroller, and a genome has to be parked under it rather than behind it.
export function stickyControlsInset(root) {
    const bar = root?.querySelector('[data-browser-global-controls="true"]')
    if (!bar || window.getComputedStyle(bar).position !== 'sticky') return 0
    return Math.round(bar.getBoundingClientRect().height)
}

// The control bar a genome is aligned by — the row carrying its pill, which is
// what the reader sees meet the app's top bar.
export function panelAlignmentAnchor(host, panelKey) {
    const wrapper = panelKey
        ? host?.querySelector(`[data-focus-panel-wrapper="${CSS.escape(panelKey)}"]`)
        : [...(host?.querySelectorAll('[data-focus-panel-wrapper]') || [])].pop()
    return wrapper?.querySelector('[data-browser-toolbar="true"]') || wrapper || null
}

// Width of the rail, and the gutter it has to fit inside. The browser view is
// laid out inside the app's 24px page padding, so a rail this wide floats in
// empty space rather than over the leftmost track labels.
export const SCROLL_RAIL_WIDTH = 22
// Keeps the ring and the end dots clear of the rounded cap.
export const SCROLL_RAIL_INSET = 14
// A press this far from the ring grabs it where it stands instead of throwing
// the page to the pressed position — the difference between nudging the view and
// jumping somewhere else.
export const SCROLL_RAIL_GRAB = 14
// Below this there is nothing worth a scroll bar, and a rail with its ring
// pinned at both ends at once would only be noise.
export const SCROLL_RAIL_MIN_OVERFLOW = 12

/** The rail's box in viewport coordinates, from the scroll container's.
 *
 *  `minScroll` is where the rail begins, and it is the first genome's own
 *  alignment rather than the top of the page. The page can be scrolled a little
 *  above that — the padding above the control bar, and the bar itself while it
 *  is locked into the page — but none of that slack belongs to a genome, and
 *  spending rail on it left a dead gap above the first dot. So the top of the
 *  rail *is* the first dot, and scrolling up past it leaves the ring there. */
export function scrollRailGeometry(hostRect, { maxScroll = 0, minScroll = 0, margin = 10 } = {}) {
    const height = Math.max(0, hostRect.height - margin * 2)
    const padding = Math.min(SCROLL_RAIL_INSET, height / 4)
    const end = Math.max(0, maxScroll)
    const start = Math.max(0, Math.min(minScroll, end))
    return {
        top: hostRect.top + margin,
        left: hostRect.left + 1,
        height,
        padding,
        track: Math.max(0, height - padding * 2),
        minScroll: start,
        maxScroll: end,
        span: end - start,
    }
}

/** Where a scroll position sits on the rail, in pixels from the rail's top. */
export function railOffsetForScroll(scrollTop, geometry) {
    const { padding, track, minScroll, span } = geometry
    if (!(span > 0) || !(track > 0)) return padding
    return padding + track * Math.min(1, Math.max(0, (scrollTop - minScroll) / span))
}

/** The inverse: what a point on the rail means as a scroll position. */
export function scrollForRailOffset(offset, geometry) {
    const { padding, track, minScroll, span } = geometry
    if (!(span > 0) || !(track > 0)) return minScroll
    return minScroll + span * Math.min(1, Math.max(0, (offset - padding) / track))
}

/** Place each genome's dot. `stops` carry the scroll position that parks them at
 *  the top; anything unmeasurable is dropped rather than drawn in the wrong place. */
export function placeScrollRailStops(stops, geometry) {
    return (stops || [])
        .filter((stop) => stop && Number.isFinite(stop.scrollTop))
        .map((stop) => ({
            ...stop,
            scrollTop: Math.min(geometry.maxScroll, Math.max(geometry.minScroll, stop.scrollTop)),
            offset: railOffsetForScroll(stop.scrollTop, geometry),
        }))
}

/** Which genome the reader is currently looking at: the last one whose control
 *  bar has reached the top, so the first genome stays current all the way down
 *  its own tracks rather than only at the single pixel it aligns on — and all the
 *  way up through the slack above its own bar, where the ring is parked on it.
 *
 *  The tolerance absorbs the sub-pixel gap a smooth scroll settles on — without
 *  it a genome parked perfectly at the top would still read as the one above. */
export function activeScrollRailStop(scrollTop, placed, tolerance = 2) {
    let index = -1
    for (let i = 0; i < placed.length; i += 1) {
        if (placed[i].scrollTop <= scrollTop + tolerance) index = i
    }
    // Above the first bar — only reachable when the page is scrolled to a
    // negative-looking rubber band — the first genome is still the one on screen.
    return index === -1 ? (placed.length ? 0 : -1) : index
}

/** The genome an arrow key moves to. Stepping back from inside a genome returns
 *  to the top of that genome first, which is what a reader part-way down its
 *  transcripts expects, rather than skipping to the one above. */
export function stepScrollRailStop(scrollTop, placed, direction, tolerance = 2) {
    if (!placed.length) return -1
    if (direction < 0) {
        for (let i = placed.length - 1; i >= 0; i -= 1) {
            if (placed[i].scrollTop < scrollTop - tolerance) return i
        }
        return 0
    }
    for (let i = 0; i < placed.length; i += 1) {
        if (placed[i].scrollTop > scrollTop + tolerance) return i
    }
    return placed.length - 1
}

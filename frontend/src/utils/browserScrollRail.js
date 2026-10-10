// Share scroll geometry between the browser rail and Cycle's Jump action.
// A genome dot marks the scroll position that aligns its control bar below
// the app's top bar. The position ring uses that same coordinate system.

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
 *  rail *is* the first dot, and scrolling up past it leaves the ring there.
 *
 *  `left` places the rail somewhere other than just inside the scroll
 *  container's left edge — for a view whose scroll container is an inner panel,
 *  so the rail can still sit in the app's page padding rather than over it. */
export function scrollRailGeometry(hostRect, { maxScroll = 0, minScroll = 0, margin = 10, left = null } = {}) {
    const height = Math.max(0, hostRect.height - margin * 2)
    const padding = Math.min(SCROLL_RAIL_INSET, height / 4)
    const end = Math.max(0, maxScroll)
    const start = Math.max(0, Math.min(minScroll, end))
    return {
        top: hostRect.top + margin,
        left: Number.isFinite(left) ? left : hostRect.left + 1,
        height,
        padding,
        track: Math.max(0, height - padding * 2),
        minScroll: start,
        maxScroll: end,
        span: end - start,
    }
}

/** Whether `placed` came from a balanced placement (see placeScrollRailStops). */
function isBalanced(placed) {
    return Array.isArray(placed) && placed.length >= 2 && placed[0]?.balanced === true
}

/** The stretch of rail and of scroll that belongs to the `index`th stop: from its
 *  own dot to the next one's, the last running to the end of each. */
function balancedSegment(placed, index, geometry) {
    const stop = placed[index]
    const next = placed[index + 1]
    return {
        fromScroll: stop.scrollTop,
        toScroll: next ? next.scrollTop : geometry.maxScroll,
        fromOffset: stop.offset,
        toOffset: next ? next.offset : geometry.padding + geometry.track,
    }
}

/** Where a scroll position sits on the rail, in pixels from the rail's top.
 *  Given balanced stops it goes through each genome's equal share of the rail at
 *  that genome's own pace, so a dot is still exactly where its genome is aligned. */
export function railOffsetForScroll(scrollTop, geometry, placed = null) {
    if (isBalanced(placed)) {
        if (!(scrollTop > placed[0].scrollTop)) return placed[0].offset
        let index = 0
        for (let i = 0; i < placed.length; i += 1) {
            if (placed[i].scrollTop <= scrollTop) index = i
        }
        const segment = balancedSegment(placed, index, geometry)
        const range = segment.toScroll - segment.fromScroll
        if (!(range > 0)) return segment.fromOffset
        const fraction = Math.min(1, Math.max(0, (scrollTop - segment.fromScroll) / range))
        return segment.fromOffset + (segment.toOffset - segment.fromOffset) * fraction
    }
    const { padding, track, minScroll, span } = geometry
    if (!(span > 0) || !(track > 0)) return padding
    return padding + track * Math.min(1, Math.max(0, (scrollTop - minScroll) / span))
}

/** The inverse: what a point on the rail means as a scroll position. */
export function scrollForRailOffset(offset, geometry, placed = null) {
    if (isBalanced(placed)) {
        const end = geometry.padding + geometry.track
        const at = Math.min(end, Math.max(geometry.padding, offset))
        let index = 0
        for (let i = 0; i < placed.length; i += 1) {
            if (placed[i].offset <= at) index = i
        }
        const segment = balancedSegment(placed, index, geometry)
        const length = segment.toOffset - segment.fromOffset
        const fraction = length > 0 ? (at - segment.fromOffset) / length : 0
        return segment.fromScroll + (segment.toScroll - segment.fromScroll) * fraction
    }
    const { padding, track, minScroll, span } = geometry
    if (!(span > 0) || !(track > 0)) return minScroll
    return minScroll + span * Math.min(1, Math.max(0, (offset - padding) / track))
}

/** Place each genome's dot. `stops` carry the scroll position that parks them at
 *  the top; anything unmeasurable is dropped rather than drawn in the wrong place.
 *
 *  By default a dot sits in proportion to the page above it. That starves the last
 *  genome: it can only scroll as far as its own control bar reaching the top, which
 *  is the end of the page, so its dot lands on the end of the rail with no band at
 *  all — two genomes read as one colour and a dot. `balanced` gives every genome an
 *  equal share instead, and the ring moves through each share at that genome's own
 *  pace (railOffsetForScroll / scrollForRailOffset, passed these stops). */
export function placeScrollRailStops(stops, geometry, { balanced = false } = {}) {
    const clamped = (stops || [])
        .filter((stop) => stop && Number.isFinite(stop.scrollTop))
        .map((stop) => ({
            ...stop,
            scrollTop: Math.min(geometry.maxScroll, Math.max(geometry.minScroll, stop.scrollTop)),
        }))
    if (!balanced || clamped.length < 2) {
        return clamped.map((stop) => ({ ...stop, offset: railOffsetForScroll(stop.scrollTop, geometry) }))
    }
    // Page order, and never backwards: a genome cannot be parked above the one before it.
    let floor = -Infinity
    return clamped.map((stop, index) => {
        floor = Math.max(floor, stop.scrollTop)
        return {
            ...stop,
            scrollTop: floor,
            offset: geometry.padding + geometry.track * (index / clamped.length),
            balanced: true,
        }
    })
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

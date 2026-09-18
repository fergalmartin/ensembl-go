// Where the box that describes one base goes.
//
// Pure arithmetic, out here rather than inline in the component, because it is
// the part with edges: a base at the right of the window, a box taller than the
// screen, a window too narrow for either side. Those are the cases nobody
// reproduces by hand and every one of them is a test here.
//
// All values are viewport pixels, as `getBoundingClientRect` gives them.

/** How wide the arrow is, and so how far the box stands off the base. */
export const POPUP_ARROW = 8

/** How close to the edge of the window the box may come. */
export const POPUP_EDGE = 10

function num(value, fallback = 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
}

/**
 * The side to open on, and where to put the box and its arrow.
 *
 * **Right of the base by default**, which is where the eye goes next along a
 * line of text, flipping left only when the right has no room. The arrow's tip
 * meets the side of the base cell, so which of sixty cells in a row is being
 * described is not a matter of inference.
 *
 * Vertically the box is centred on the base and then pushed back inside the
 * window if it would hang off. The arrow does not move with it: it stays level
 * with the base and slides along the box's side instead, so a long box near the
 * bottom of the screen still points at the right row.
 */
export function placePopup({
    anchor,
    panelWidth,
    panelHeight = 0,
    viewportWidth,
    viewportHeight,
} = {}) {
    const left = num(anchor?.left)
    const right = num(anchor?.right, left)
    const mid = num(anchor?.mid)
    const width = Math.max(0, num(panelWidth))
    const height = Math.max(0, num(panelHeight))
    const room = Math.max(0, num(viewportWidth))
    const tall = Math.max(0, num(viewportHeight))

    const fitsRight = room - right - POPUP_ARROW - POPUP_EDGE >= width
    const fitsLeft = left - POPUP_ARROW - POPUP_EDGE >= width
    // Right unless it will not fit; left if that is where the room is; and with
    // room on neither side, right anyway, pushed in from the edge -- the arrow
    // then points the right way even though it no longer touches, which is
    // better than a box half off the screen.
    const side = fitsRight || !fitsLeft ? 'right' : 'left'

    const x = side === 'right'
        ? Math.min(right + POPUP_ARROW, Math.max(POPUP_EDGE, room - width - POPUP_EDGE))
        : Math.max(POPUP_EDGE, left - POPUP_ARROW - width)

    // Before the box has been measured there is nothing to clamp against, so it
    // is centred on the base and the arrow is at its middle -- which is right
    // whenever it fits, and corrected on the next frame when it does not.
    if (!height) {
        return { side, left: x, top: mid - height / 2, arrow: height / 2, measured: false }
    }

    const top = Math.max(POPUP_EDGE, Math.min(mid - height / 2, tall - height - POPUP_EDGE))
    const arrow = Math.max(POPUP_ARROW, Math.min(mid - top, height - POPUP_ARROW))
    return { side, left: x, top, arrow, measured: true }
}

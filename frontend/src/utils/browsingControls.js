/**
 * Shared input resolution for the pan/zoom surfaces.
 *
 * A "browsing control scheme" maps input gestures onto navigation intents. The
 * caller reads an intent and acts on it; it must never re-derive sensitivity,
 * direction, or policy such as whether to preventDefault.
 *
 * Everything here except `readWheelEvent` / `readKeyEvent` / `isTextEntryTarget`
 * is pure and takes plain descriptors, so the whole decision layer is
 * unit-testable without a DOM.
 */

export const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

// ---------------------------------------------------------------------------
// Wheel delta normalisation
// ---------------------------------------------------------------------------

/** Chromium reports ~16px per line for `deltaMode: DOM_DELTA_LINE`. */
export const WHEEL_LINE_HEIGHT_PX = 16

/**
 * Convert a wheel event's deltas to pixels.
 *
 * Firefox and some Linux mice report `deltaMode: 1` (lines) with deltas around
 * 3, rather than `deltaMode: 0` (pixels) with deltas around 100. Without this
 * the same physical gesture is ~30x weaker on those setups.
 */
export function normalizeWheelDelta(event, options = {}) {
    const lineHeight = Number(options.lineHeight) || WHEEL_LINE_HEIGHT_PX
    const pageHeight = Number(options.pageHeight) || (lineHeight * 20)
    const mode = Number(event?.deltaMode) || 0
    const unit = mode === 1 ? lineHeight : (mode === 2 ? pageHeight : 1)
    const rawX = Number(event?.deltaX)
    const rawY = Number(event?.deltaY)
    return {
        dx: (Number.isFinite(rawX) ? rawX : 0) * unit,
        dy: (Number.isFinite(rawY) ? rawY : 0) * unit,
    }
}

// ---------------------------------------------------------------------------
// Zoom factor
// ---------------------------------------------------------------------------

/**
 * Largest exponent a single wheel event may contribute, so one mouse notch
 * cannot swallow the whole zoom range. exp(0.5) ≈ 1.65x per event.
 */
export const WHEEL_ZOOM_MAX_EXPONENT = 0.5

/**
 * Delta -> multiplicative span factor. Positive delta (scrolling down/away)
 * returns > 1, which widens the span, i.e. zooms out.
 *
 * Exponential rather than the older `1 + delta * sensitivity` for two reasons:
 *
 *  1. `1 + delta * s` goes NEGATIVE for a real mouse wheel. Chromium sends
 *     deltaY ≈ ±120 per notch, so at the ctrl sensitivity of 0.01 a single
 *     notch produced -0.2. The resulting negative span was silently absorbed by
 *     the MIN_VIEW_SPAN clamp, so one notch jumped from any zoom level straight
 *     to 50bp.
 *  2. It is sign-symmetric: zooming in and back out returns to the same span.
 *     The linear form does not (1.1 * 0.9 = 0.99).
 *
 * For trackpad-sized deltas the two agree closely (within ~0.5% up to |delta|
 * of 20), so this does not change how a trackpad feels.
 */
export function wheelZoomFactor(deltaPx, sensitivity) {
    const delta = Number(deltaPx)
    const k = Number(sensitivity)
    if (!Number.isFinite(delta) || !Number.isFinite(k) || k === 0) return 1
    const exponent = clamp(delta * k, -WHEEL_ZOOM_MAX_EXPONENT, WHEEL_ZOOM_MAX_EXPONENT)
    return Math.exp(exponent)
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** What a gesture can be bound to. Closed set. */
export const BROWSING_CONTROL_ACTIONS = Object.freeze([
    'zoom_at_cursor',
    'zoom_at_center',
    'pan',
    'page_scroll',
    'none',
])

/** Wheel gesture slots, `<modifier>_<axis>`. `ctrl` also covers meta/⌘. */
export const WHEEL_GESTURE_SLOTS = Object.freeze([
    'plain_vertical',
    'plain_horizontal',
    'ctrl_vertical',
    'ctrl_horizontal',
    'shift_vertical',
    'shift_horizontal',
    'alt_vertical',
    'alt_horizontal',
])

/** Below this the event is treated as noise. Matches the historic dead zone. */
export const WHEEL_DEAD_ZONE_PX = 0.5

/** Horizontal wheel panning has always been amplified; keep the feel. */
export const WHEEL_PAN_AMPLIFICATION = 2

/** Zoom sensitivities, unchanged from the original hard-coded handler. */
export const WHEEL_ZOOM_SENSITIVITY = 0.005
export const WHEEL_PINCH_SENSITIVITY = 0.01

/**
 * A continuing trackpad gesture keeps its mode for this long, so an inertial
 * fling cannot flip between zooming and scrolling halfway through.
 */
export const WHEEL_GESTURE_IDLE_MS = 180

/** Drag must exceed this before an axis is chosen. */
export const DRAG_AXIS_THRESHOLD_PX = 5

/**
 * Vertical bias when a page scroller exists: a drag within ~37 degrees of
 * vertical scrolls rather than pans.
 */
export const DRAG_VERTICAL_BIAS = 0.75

// ---------------------------------------------------------------------------
// Scheme registry
// ---------------------------------------------------------------------------

export const DEFAULT_BROWSING_CONTROL_SCHEME_ID = 'default'

const SCHEME_DEFINITIONS = [
    {
        id: 'default',
        label: 'Default',
        description:
            'The wheel zooms in and out on the position under the cursor, and scrolling '
            + 'sideways moves along the chromosome. Best when one genome fills the window.',
        wheel: {
            plain_vertical: 'zoom_at_cursor',
            plain_horizontal: 'pan',
            // A two-finger swipe already zooms here, so a pinch would be a second
            // way to do the same thing. Bound to nothing so the plain gesture is
            // the only one — note this still suppresses the browser's own page
            // zoom, which is enforced for ctrl in resolveWheelAction.
            ctrl_vertical: 'none',
            ctrl_horizontal: 'none',
            shift_vertical: 'zoom_at_cursor',
            shift_horizontal: 'pan',
            alt_vertical: 'zoom_at_cursor',
            alt_horizontal: 'pan',
        },
    },
    {
        id: 'wheel_scrolls',
        label: 'Wheel scrolls',
        description:
            'The wheel scrolls the page up and down, so you can move between genomes as '
            + 'you would in any other window. Hold Ctrl and use the wheel to zoom on the '
            + 'position under the cursor; hold Shift to move along the chromosome.',
        wheel: {
            plain_vertical: 'page_scroll',
            plain_horizontal: 'pan',
            ctrl_vertical: 'zoom_at_cursor',
            ctrl_horizontal: 'zoom_at_cursor',
            shift_vertical: 'pan',
            shift_horizontal: 'pan',
            alt_vertical: 'page_scroll',
            alt_horizontal: 'pan',
        },
    },
    {
        id: 'wheel_pans',
        label: 'Wheel pans',
        description:
            'The wheel moves along the chromosome. Hold Ctrl and use the wheel to zoom on '
            + 'the position under the cursor; hold Shift to scroll the page up and down.',
        wheel: {
            plain_vertical: 'pan',
            plain_horizontal: 'pan',
            ctrl_vertical: 'zoom_at_cursor',
            ctrl_horizontal: 'zoom_at_cursor',
            shift_vertical: 'page_scroll',
            shift_horizontal: 'pan',
            alt_vertical: 'pan',
            alt_horizontal: 'pan',
        },
    },
]

export const BROWSING_CONTROL_SCHEME_IDS = Object.freeze(SCHEME_DEFINITIONS.map((s) => s.id))

/**
 * Public registry for the settings UI. Bindings are frozen so a consumer cannot
 * mutate a shared scheme by accident.
 */
export const BROWSING_CONTROL_SCHEMES = Object.freeze(
    SCHEME_DEFINITIONS.map((scheme) => Object.freeze({
        id: scheme.id,
        label: scheme.label,
        description: scheme.description,
        wheel: Object.freeze({ ...scheme.wheel }),
    }))
)

const SCHEMES_BY_ID = new Map(BROWSING_CONTROL_SCHEMES.map((scheme) => [scheme.id, scheme]))

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/** Ids saved before a scheme was renamed. */
const LEGACY_SCHEME_ALIASES = {
    mouse_keyboard: 'wheel_scrolls',
}

/** Configs written before this feature, or hand-edited, must never throw. */
export function normalizeBrowsingControlSchemeId(candidate) {
    const raw = String(candidate ?? '').trim()
    const id = LEGACY_SCHEME_ALIASES[raw] || raw
    return SCHEMES_BY_ID.has(id) ? id : DEFAULT_BROWSING_CONTROL_SCHEME_ID
}

export function browsingControlsSignature(config) {
    return normalizeBrowsingControlSchemeId(config?.browsing_control_scheme)
}

const RESOLVED_CACHE = new Map()

/**
 * Feel parameters a view may override. The *mapping* (which gesture does what)
 * is the user's choice and is never overridable; only the rate at which a view
 * responds is, because a 3kb transcript track and a 50Mb chromosome view need
 * different sensitivities to feel the same under the same gesture.
 */
const TUNING_DEFAULTS = Object.freeze({
    zoomSensitivity: WHEEL_ZOOM_SENSITIVITY,
    pinchSensitivity: WHEEL_PINCH_SENSITIVITY,
    panAmplification: WHEEL_PAN_AMPLIFICATION,
    // Once the view is at its zoom limit, a continuing zoom gesture hands off to
    // page scrolling instead of going dead. On for every scheme.
    zoomAtExtentHandoff: true,
})

const TUNING_KEYS = Object.keys(TUNING_DEFAULTS)

function normalizeTuning(tuning) {
    const out = {}
    for (const key of TUNING_KEYS) {
        const value = tuning?.[key]
        if (value === undefined || value === null) continue
        if (key === 'zoomAtExtentHandoff') {
            out[key] = Boolean(value)
            continue
        }
        const numeric = Number(value)
        if (Number.isFinite(numeric) && numeric > 0) out[key] = numeric
    }
    return out
}

/**
 * Resolve a config into a frozen controls object.
 *
 * IDENTITY-STABLE by design: `config` gets a fresh object identity on every
 * 250ms autosave, including autosaves triggered by unrelated edits. Returning a
 * new controls object each time would land in a wheel-listener dependency array
 * and re-register the listener mid-gesture. The cache key therefore folds in the
 * tuning overrides, so a view that passes the same overrides on every render
 * still gets the same object back.
 *
 * @param tuning optional per-view feel overrides; see TUNING_DEFAULTS
 */
export function resolveBrowsingControls(config, tuning = null) {
    const id = browsingControlsSignature(config)
    const overrides = normalizeTuning(tuning)
    const key = TUNING_KEYS.reduce(
        (acc, name) => (name in overrides ? `${acc}|${name}=${overrides[name]}` : acc),
        id
    )
    const cached = RESOLVED_CACHE.get(key)
    if (cached) return cached

    const scheme = SCHEMES_BY_ID.get(id)
    const resolved = Object.freeze({
        schemeId: scheme.id,
        label: scheme.label,
        description: scheme.description,
        wheel: Object.freeze({ ...scheme.wheel }),
        ...TUNING_DEFAULTS,
        ...overrides,
    })
    RESOLVED_CACHE.set(key, resolved)
    return resolved
}

export const DEFAULT_BROWSING_CONTROLS = resolveBrowsingControls(null)

// ---------------------------------------------------------------------------
// Event adapters (the only DOM-aware functions)
// ---------------------------------------------------------------------------

export function readWheelEvent(event, options = {}) {
    const { dx, dy } = normalizeWheelDelta(event, options)
    return {
        dx,
        dy,
        // ⌘ on macOS behaves as ctrl for zoom intent, and Firefox uses it for
        // page zoom, so it must be treated identically everywhere.
        ctrl: Boolean(event?.ctrlKey || event?.metaKey),
        shift: Boolean(event?.shiftKey),
        alt: Boolean(event?.altKey),
        ts: Number.isFinite(Number(event?.timeStamp)) ? Number(event.timeStamp) : 0,
    }
}

export function readKeyEvent(event) {
    return {
        key: String(event?.key ?? ''),
        ctrl: Boolean(event?.ctrlKey),
        meta: Boolean(event?.metaKey),
        shift: Boolean(event?.shiftKey),
        alt: Boolean(event?.altKey),
        repeat: Boolean(event?.repeat),
    }
}

const TEXT_ENTRY_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

/** Duck-typed so it can be unit-tested without a DOM. */
export function isTextEntryTarget(target) {
    if (!target) return false
    if (target.isContentEditable) return true
    return TEXT_ENTRY_TAGS.has(String(target.tagName ?? '').toUpperCase())
}

/**
 * Marks a wheel event as seen by a panel, so an ancestor fallback listener can
 * tell "a panel handled this" from "no panel saw it".
 *
 * A WeakSet rather than stopPropagation, because page-scroll and no-op intents
 * deliberately let the event keep bubbling.
 */
const HANDLED_WHEEL_EVENTS = new WeakSet()

export function markWheelHandled(event) {
    if (event && typeof event === 'object') HANDLED_WHEEL_EVENTS.add(event)
}

export function isWheelHandled(event) {
    return Boolean(event && typeof event === 'object' && HANDLED_WHEEL_EVENTS.has(event))
}

/**
 * Nearest ancestor that can actually scroll vertically, or null.
 *
 * Whether a surface can page-scroll is a property of where it sits in the
 * document, not something a view can hard-code: the app's content container
 * only becomes `overflow-y-auto` for certain views, and only overflows for
 * certain content. Getting this wrong silently collapses one scheme into
 * another, because a `page_scroll` binding with nothing to scroll does nothing.
 *
 * Crosses shadow boundaries, so it works from inside a web component.
 */
export function findNearestScrollable(element) {
    let current = element
    while (current && current !== document.body) {
        if (current.nodeType === 1) {
            const overflowY = window.getComputedStyle(current).overflowY
            if ((overflowY === 'auto' || overflowY === 'scroll')
                && current.scrollHeight > current.clientHeight + 1) {
                return current
            }
        }
        current = current.parentElement || current.parentNode?.host || null
    }
    return null
}

// ---------------------------------------------------------------------------
// Gesture continuity
// ---------------------------------------------------------------------------

/**
 * A macOS trackpad emits inertial wheel events for up to a second after the
 * fingers lift. Latching keeps a fling in the mode it started in, but only
 * while the kind, the direction and the timing all agree.
 */
export function beginWheelGesture(previous, wheel, nowMs) {
    const kind = Math.abs(wheel.dy) >= Math.abs(wheel.dx) ? 'vertical' : 'horizontal'
    const magnitude = kind === 'vertical' ? wheel.dy : wheel.dx
    const direction = magnitude === 0 ? 0 : (magnitude > 0 ? 1 : -1)
    const continues = Boolean(
        previous
        && previous.kind === kind
        && previous.direction === direction
        && Number.isFinite(previous.lastTs)
        && (nowMs - previous.lastTs) <= WHEEL_GESTURE_IDLE_MS
    )
    return {
        kind,
        direction,
        mode: continues ? previous.mode : '',
        // Exposed so a caller can tell "this event started a gesture" from
        // "this event continues one" — FeatureExplorerView needs it to decide
        // whether a fling began inside or outside its panel.
        continues,
        lastTs: nowMs,
    }
}

// ---------------------------------------------------------------------------
// Wheel resolution
// ---------------------------------------------------------------------------

function wheelSlot(wheel) {
    const axis = Math.abs(wheel.dy) >= Math.abs(wheel.dx) ? 'vertical' : 'horizontal'
    const modifier = wheel.ctrl ? 'ctrl' : (wheel.shift ? 'shift' : (wheel.alt ? 'alt' : 'plain'))
    return `${modifier}_${axis}`
}

const noopIntent = (wheel) => ({
    type: 'none',
    // Ctrl/⌘ + wheel must ALWAYS be prevented, in every scheme and every
    // branch. Chromium applies page zoom otherwise, which desyncs the canvas
    // backing-store DPR until the app restarts.
    preventDefault: Boolean(wheel.ctrl),
    stopPropagation: false,
    nextGestureMode: '',
    captureScrollAnchor: false,
    releaseScrollAnchors: false,
})

const pageScrollIntent = () => ({
    type: 'page_scroll',
    mode: 'native',
    // Never prevent, or the page cannot scroll. Never stop propagation, or an
    // ancestor fallback listener never sees the event.
    preventDefault: false,
    stopPropagation: false,
    nextGestureMode: 'scroll',
    captureScrollAnchor: false,
    // The adaptive panel anchor and the transcript-row zoom anchor both scroll
    // the page imperatively on a rAF loop. Left running they fight native
    // scrolling for a frame or two, which reads as judder.
    releaseScrollAnchors: true,
})

/**
 * @param wheel   from `readWheelEvent`
 * @param controls from `resolveBrowsingControls`
 * @param context { atMinZoom, atMaxZoom, canScrollPage, gesture }
 */
export function resolveWheelAction(wheel, controls, context = {}) {
    const resolved = controls || DEFAULT_BROWSING_CONTROLS
    const magnitude = Math.max(Math.abs(wheel.dx), Math.abs(wheel.dy))
    if (magnitude <= WHEEL_DEAD_ZONE_PX) return noopIntent(wheel)

    const slot = wheelSlot(wheel)
    let action = resolved.wheel[slot] || 'none'

    // Not every surface can zoom (the neighbourhood track only pans). Degrading
    // to pan rather than to nothing keeps a scheme usable everywhere: under
    // Default a plain vertical wheel still moves the track, which is what it did
    // before schemes existed.
    if (context.canZoom === false && (action === 'zoom_at_cursor' || action === 'zoom_at_center')) {
        action = 'pan'
    }

    if (action === 'none') return noopIntent(wheel)

    if (action === 'page_scroll') {
        // Nothing to scroll: fall through to a no-op rather than swallowing the
        // gesture, so the browser is still free to do whatever it would have.
        if (context.canScrollPage === false) return noopIntent(wheel)
        return pageScrollIntent()
    }

    if (action === 'pan') {
        const axisDelta = Math.abs(wheel.dy) >= Math.abs(wheel.dx) ? wheel.dy : wheel.dx
        return {
            type: 'pan',
            dxPx: axisDelta * resolved.panAmplification,
            preventDefault: true,
            stopPropagation: true,
            nextGestureMode: 'pan',
            captureScrollAnchor: true,
            releaseScrollAnchors: false,
        }
    }

    // Zoom.
    const zoomDelta = Math.abs(wheel.dy) >= Math.abs(wheel.dx) ? wheel.dy : wheel.dx
    const zoomingOut = zoomDelta > 0
    const atExtent = zoomingOut ? context.atMaxZoom === true : context.atMinZoom === true

    // Already at the zoom limit: hand over to page scrolling rather than letting
    // the wheel go dead. Latched, so a trackpad fling that began as a hand-off
    // keeps scrolling instead of flickering back into zoom mid-gesture.
    //
    // Only for unmodified gestures. Holding Ctrl is an explicit request to zoom,
    // and silently scrolling the page instead would be surprising.
    const unmodified = !wheel.ctrl && !wheel.shift && !wheel.alt
    const handingOff = resolved.zoomAtExtentHandoff
        && unmodified
        && context.canScrollPage !== false
        && (atExtent || context.gesture?.mode === 'scroll')
    if (handingOff) return pageScrollIntent()

    const sensitivity = wheel.ctrl ? resolved.pinchSensitivity : resolved.zoomSensitivity
    return {
        type: 'zoom',
        factor: wheelZoomFactor(zoomDelta, sensitivity),
        anchor: action === 'zoom_at_center' ? 'center' : 'cursor',
        preventDefault: true,
        stopPropagation: true,
        nextGestureMode: 'zoom',
        captureScrollAnchor: true,
        releaseScrollAnchors: false,
    }
}

// ---------------------------------------------------------------------------
// Drag resolution
// ---------------------------------------------------------------------------

/**
 * Decide whether a drag pans horizontally or scrolls the page.
 *
 * Identical in every scheme: drag is the most muscle-memory-loaded gesture in
 * the app, and varying it per scheme would make the setting unpredictable.
 *
 * @param dx/dy   total offset from the drag origin (start minus current)
 * @param currentAxis already-locked axis, returned unchanged when set
 */
export function resolveDragAxis({ dx, dy, canScrollPage, currentAxis = null }) {
    if (currentAxis) return currentAxis
    const absX = Math.abs(Number(dx) || 0)
    const absY = Math.abs(Number(dy) || 0)
    if (absX <= DRAG_AXIS_THRESHOLD_PX && absY <= DRAG_AXIS_THRESHOLD_PX) return null
    // Biased towards scrolling when there is somewhere to scroll, so a roughly
    // vertical drag moves between genomes rather than nudging the viewport.
    if (canScrollPage && absY >= absX * DRAG_VERTICAL_BIAS) return 'y'
    return absX >= absY ? 'x' : 'y'
}

// ---------------------------------------------------------------------------
// Keyboard resolution
// ---------------------------------------------------------------------------

/**
 * The key map is deliberately identical in every scheme. Schemes differ only in
 * pointer semantics; making the keyboard scheme-dependent would leave Default
 * users with no keyboard access at all, which is an accessibility regression.
 *
 * Up/Down are deliberately unbound so the page scrolls natively, which is what
 * users expect. AlignmentPanel binds them to zoom today and it is confusing.
 */
export function resolveKeyAction(keyDesc) {
    const key = String(keyDesc?.key ?? '')
    // Never shadow OS or app-level shortcuts.
    if (keyDesc?.meta) return { type: 'none', preventDefault: false }

    const shift = Boolean(keyDesc?.shift)
    const alt = Boolean(keyDesc?.alt)

    const panFraction = shift ? 0.5 : (alt ? 0.01 : 0.1)
    const pan = (sign) => ({
        type: 'pan',
        dxFraction: sign * panFraction,
        fineStep: alt,
        preventDefault: true,
    })

    switch (key) {
        case 'ArrowLeft': return pan(-1)
        case 'ArrowRight': return pan(1)
        case 'PageUp': return { type: 'pan', dxFraction: -1, preventDefault: true }
        case 'PageDown': return { type: 'pan', dxFraction: 1, preventDefault: true }
        case 'Home': return { type: 'jump', edge: 'start', preventDefault: true }
        case 'End': return { type: 'jump', edge: 'end', preventDefault: true }
        case '+':
        case '=':
            return { type: 'zoom', factor: shift ? 1 / 2 : 1 / 1.25, anchor: 'center', preventDefault: true }
        case '-':
        case '_':
            return { type: 'zoom', factor: shift ? 2 : 1.25, anchor: 'center', preventDefault: true }
        case '0': return { type: 'reset', scope: 'chromosome', preventDefault: true }
        case 'f':
        case 'F':
            return { type: 'reset', scope: 'gene', preventDefault: true }
        case 'Escape': return { type: 'dismiss', preventDefault: true }
        default:
            return { type: 'none', preventDefault: false }
    }
}

// ---------------------------------------------------------------------------
// Panel targeting (for a gesture landing between panels)
// ---------------------------------------------------------------------------

/**
 * Nearest panel to a point, used when a ctrl+wheel lands in the page padding or
 * on the divider between two panels, where no panel listener fires.
 *
 * Ties resolve to the earlier entry, so the 2px divider is deterministic.
 */
export function pickNearestPanel(clientY, clientX, panelRects) {
    const rects = Array.isArray(panelRects) ? panelRects : []
    const y = Number(clientY)
    if (!rects.length || !Number.isFinite(y)) return null

    let best = null
    let bestDistance = Infinity
    for (const rect of rects) {
        if (!rect) continue
        const top = Number(rect.top)
        const bottom = Number(rect.bottom)
        if (!Number.isFinite(top) || !Number.isFinite(bottom)) continue
        const distance = y < top ? (top - y) : (y > bottom ? (y - bottom) : 0)
        if (distance < bestDistance) {
            bestDistance = distance
            best = rect
        }
    }
    if (!best) return null

    const x = Number(clientX)
    const left = Number(best.left)
    const right = Number(best.right)
    const insideHorizontally = Number.isFinite(x) && Number.isFinite(left) && Number.isFinite(right)
        && x >= left && x <= right
    return {
        panelKey: best.panelKey,
        insideVertically: bestDistance === 0,
        insideHorizontally,
    }
}

// ---------------------------------------------------------------------------
// Description (settings cheat sheet + screen-reader hint)
// ---------------------------------------------------------------------------

const ACTION_LABELS = {
    zoom_at_cursor: 'Zoom on the position under the cursor',
    zoom_at_center: 'Zoom on the centre of the view',
    pan: 'Move along the chromosome',
    page_scroll: 'Scroll the page up and down',
    none: 'Nothing',
}

/** Input devices the cheat sheet can be shown for. */
export const BROWSING_CONTROL_DEVICES = Object.freeze([
    { id: 'mouse', label: 'Mouse & keyboard' },
    { id: 'trackpad', label: 'Trackpad' },
])

// A trackpad produces the same wheel events as a mouse — a pinch arrives as
// ctrl+wheel — so only the wording differs, never the mapping.
const GESTURE_LABELS = {
    mouse: {
        plain_vertical: 'Wheel up/down',
        plain_horizontal: 'Wheel sideways',
        ctrl_vertical: 'Ctrl (or ⌘) + wheel up/down',
        shift_vertical: 'Shift + wheel up/down',
        alt_vertical: 'Alt + wheel up/down',
    },
    trackpad: {
        plain_vertical: 'Two-finger swipe up/down',
        plain_horizontal: 'Two-finger swipe left/right',
        ctrl_vertical: 'Pinch, or Ctrl + two-finger swipe',
        shift_vertical: 'Shift + two-finger swipe up/down',
        alt_vertical: 'Alt + two-finger swipe up/down',
    },
}

const DRAG_LABELS = {
    mouse: { sideways: 'Drag sideways', vertical: 'Drag up/down' },
    trackpad: { sideways: 'Click and drag sideways', vertical: 'Click and drag up/down' },
}

const DESCRIBED_SLOTS = [
    'plain_vertical',
    'ctrl_vertical',
    'shift_vertical',
    'alt_vertical',
    'plain_horizontal',
]

/**
 * Rows for the settings cheat sheet, generated from the resolved scheme so the
 * documentation cannot drift from the behaviour.
 *
 * Modifier rows are hidden when holding the modifier does nothing — i.e. when
 * `Shift + wheel up/down` resolves to the same action as plain `wheel up/down`.
 * Listing both would just be two ways of describing one control. Rows for
 * genuinely different controls that happen to share an action (wheel sideways
 * and drag sideways both pan) are kept, because those are real alternatives.
 *
 * Unbound gestures are omitted entirely rather than listed as doing nothing.
 *
 * Keyboard shortcuts are device-independent and appear only under 'mouse', which
 * is the tab that names the keyboard.
 */
export function describeBrowsingControls(controls, device = 'mouse') {
    const resolved = controls || DEFAULT_BROWSING_CONTROLS
    const gestures = GESTURE_LABELS[device] || GESTURE_LABELS.mouse
    const drag = DRAG_LABELS[device] || DRAG_LABELS.mouse

    const rows = []
    for (const slot of DESCRIBED_SLOTS) {
        const action = resolved.wheel[slot]
        if (!action || action === 'none') continue
        const [modifier, axis] = slot.split('_')
        if (modifier !== 'plain' && action === resolved.wheel[`plain_${axis}`]) continue
        rows.push({ gesture: gestures[slot] || slot, action: ACTION_LABELS[action] || action })
    }
    rows.push({ gesture: drag.sideways, action: 'Move along the chromosome' })
    rows.push({ gesture: drag.vertical, action: 'Scroll the page up and down' })

    if (device !== 'trackpad') {
        rows.push({ gesture: 'Left / Right arrows', action: 'Move along the chromosome (Shift for a bigger step)' })
        rows.push({ gesture: '+ / -', action: 'Zoom in and out' })
        rows.push({ gesture: 'Home / End', action: 'Jump to the start or end of the chromosome' })
        rows.push({ gesture: '0 / F', action: 'Fit the whole chromosome, or the selected gene' })
    }
    return rows
}

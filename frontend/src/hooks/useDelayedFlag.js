import { useEffect, useRef, useState } from 'react'

/**
 * Debounce for a loading indicator.
 *
 * Panning and zooming refetch constantly, and most of those fetches land in a
 * few tens of milliseconds — often for data outside the current window. Showing
 * a spinner for each one is pure noise: it draws the eye to a problem that isn't
 * there, and it flickers.
 *
 * Two rules, both needed:
 *  - nothing appears until the work has run for `delayMs`, so quick loads stay
 *    invisible;
 *  - once something has appeared it stays for `minVisibleMs`, so a load that
 *    finishes just after the threshold does not produce a one-frame flash.
 */

/** Long enough to cover a warm fetch; short enough to feel responsive. */
export const DEFAULT_LOADING_DELAY_MS = 400
/** Below roughly this, an indicator reads as a glitch rather than information. */
export const DEFAULT_MIN_VISIBLE_MS = 300

/**
 * Pure policy, so the timing is testable without fake timers or a renderer.
 *
 * @returns {{ visible: boolean, wakeAt: number|null }} `wakeAt` is when the
 *   caller must re-evaluate, or null if the state is stable.
 */
export function resolveDelayedFlag({
    active,
    visible,
    activeSince,
    visibleSince,
    now,
    delayMs = DEFAULT_LOADING_DELAY_MS,
    minVisibleMs = DEFAULT_MIN_VISIBLE_MS,
}) {
    if (active && !visible) {
        const dueAt = Number(activeSince) + delayMs
        if (now >= dueAt) return { visible: true, wakeAt: null }
        return { visible: false, wakeAt: dueAt }
    }
    if (!active && visible) {
        const dueAt = Number(visibleSince) + minVisibleMs
        if (now >= dueAt) return { visible: false, wakeAt: null }
        return { visible: true, wakeAt: dueAt }
    }
    return { visible, wakeAt: null }
}

export default function useDelayedFlag(active, options = {}) {
    const delayMs = Number(options.delayMs ?? DEFAULT_LOADING_DELAY_MS)
    const minVisibleMs = Number(options.minVisibleMs ?? DEFAULT_MIN_VISIBLE_MS)
    const [visible, setVisible] = useState(false)
    const activeSinceRef = useRef(0)
    const visibleSinceRef = useRef(0)
    const wasActiveRef = useRef(false)

    useEffect(() => {
        // Stamped here rather than during render: `Date.now()` is impure, and a
        // re-render for an unrelated reason would otherwise restart the delay.
        if (active && !wasActiveRef.current) activeSinceRef.current = Date.now()
        wasActiveRef.current = active

        let timer = null
        const evaluate = () => {
            const { visible: next, wakeAt } = resolveDelayedFlag({
                active,
                visible,
                activeSince: activeSinceRef.current,
                visibleSince: visibleSinceRef.current,
                now: Date.now(),
                delayMs,
                minVisibleMs,
            })
            if (next !== visible) {
                if (next) visibleSinceRef.current = Date.now()
                setVisible(next)
                return
            }
            if (wakeAt !== null) {
                timer = setTimeout(evaluate, Math.max(0, wakeAt - Date.now()))
            }
        }
        evaluate()
        return () => { if (timer) clearTimeout(timer) }
    }, [active, visible, delayMs, minVisibleMs])

    return visible
}

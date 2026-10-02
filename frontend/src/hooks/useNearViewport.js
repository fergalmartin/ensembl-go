import { useEffect, useState } from 'react'

const NEAR_VIEWPORT_MARGIN = '600px 0px'

// rootMargin only grows the observer's root. With the default root (the window)
// a nested scroll container still clips at its own edge, so a panel inside the
// app's overflow-y-auto content area would only wake once it was already being
// scrolled into view. Observe against that container instead.
function findScrollRoot(element) {
    let current = element?.parentElement || null
    while (current && current !== document.body && current !== document.documentElement) {
        const overflowY = window.getComputedStyle(current).overflowY
        if (overflowY === 'auto' || overflowY === 'scroll') return current
        current = current.parentElement
    }
    return null
}

// Keep panels mounted and their data warm. Only expensive canvas painting sleeps
// off screen; the margin wakes it before an ordinary scroll reaches the panel.
// `active` re-resolves the scroll root: the app's content area only becomes
// scrollable while the view that owns the element is the one on screen.
export default function useNearViewport(elementRef, active = true) {
    const [nearViewport, setNearViewport] = useState(true)

    useEffect(() => {
        const element = elementRef.current
        if (!active || !element || typeof IntersectionObserver !== 'function') return undefined
        const observer = new IntersectionObserver(([entry]) => {
            setNearViewport(entry.isIntersecting)
        }, { root: findScrollRoot(element), rootMargin: NEAR_VIEWPORT_MARGIN })
        observer.observe(element)
        return () => observer.disconnect()
    }, [elementRef, active])

    return nearViewport
}

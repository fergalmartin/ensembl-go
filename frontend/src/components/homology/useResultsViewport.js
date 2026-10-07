import { useEffect, useRef } from 'react'
import { resultsScrollPlan } from './scroll.js'

export default function useResultsViewport() {
    const rootRef = useRef(null)
    const resultsRef = useRef(null)

    useEffect(() => {
        const root = rootRef.current
        const results = resultsRef.current
        if (!root || !results) return
        results.style.removeProperty('height')

        // The rows (including their sticky column headers) fill the workspace.
        // Tabs and summary metadata can move above it as the page scrolls down.
        let greatestChrome = 0
        const resize = () => {
            const stage = results.querySelector('[data-homology-stage]')
            const pagination = results.querySelector('[data-homology-pagination]')
            if (!stage || !pagination) return
            const rowHeight = Math.max(200, root.clientHeight - pagination.offsetHeight)
            results.style.setProperty('--homology-rows-height', `${rowHeight}px`)
            const chrome = stage.getBoundingClientRect().top - results.getBoundingClientRect().top + pagination.offsetHeight + 1
            greatestChrome = Math.max(greatestChrome, chrome)
            // Keep the outer page from shrinking on shorter tabs or while loading.
            results.style.minHeight = `${rowHeight + greatestChrome}px`
        }
        resize()
        const observer = new ResizeObserver(resize)
        observer.observe(root)
        observer.observe(results)

        const move = (rows, delta) => {
            const plan = resultsScrollPlan({
                delta,
                outerTop: root.scrollTop,
                outerMax: root.scrollHeight - root.clientHeight,
                rowsTop: rows.getBoundingClientRect().top - root.getBoundingClientRect().top - root.clientTop,
                innerTop: rows.scrollTop,
                innerMax: rows.scrollHeight - rows.clientHeight,
            })
            root.scrollTop = plan.outerTop
            rows.scrollTop = plan.innerTop
        }
        const wheel = event => {
            const rows = event.target.closest?.('[data-homology-rows]')
            if (!rows || event.ctrlKey || event.shiftKey || !event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return
            event.preventDefault()
            const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rows.clientHeight : 1
            move(rows, event.deltaY * unit)
            rows.scrollLeft += event.deltaX * unit
        }
        const keydown = event => {
            const rows = event.target
            if (!rows.matches('[data-homology-rows]') || event.ctrlKey || event.metaKey || event.altKey) return
            const delta = { ArrowDown: 40, ArrowUp: -40, PageDown: rows.clientHeight * .9, PageUp: -rows.clientHeight * .9 }[event.key]
            if (delta !== undefined) {
                event.preventDefault()
                move(rows, delta)
            }
        }
        // React's delegated wheel handler is passive; a native listener is
        // needed to transfer each gesture without also scrolling the inner list.
        results.addEventListener('wheel', wheel, { passive: false })
        results.addEventListener('keydown', keydown)
        return () => {
            observer.disconnect()
            results.removeEventListener('wheel', wheel)
            results.removeEventListener('keydown', keydown)
        }
    }, [])

    return { rootRef, resultsRef }
}

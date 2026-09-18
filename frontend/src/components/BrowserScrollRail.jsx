import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
    findScrollHost,
    stickyControlsInset,
    panelAlignmentAnchor,
    scrollRailGeometry,
    railOffsetForScroll,
    scrollForRailOffset,
    placeScrollRailStops,
    activeScrollRailStop,
    stepScrollRailStop,
    SCROLL_RAIL_WIDTH,
    SCROLL_RAIL_GRAB,
    SCROLL_RAIL_MIN_OVERFLOW,
} from '../utils/browserScrollRail'
import { CYCLE_DRAG_THRESHOLD } from '../utils/genomeWheel'
import './BrowserScrollRail.css'

// How far an arrow key moves the page, and a page key.
const ARROW_STEP = 72
const PAGE_FRACTION = 0.9

// The measurement the rail redraws from. Compared as a string rather than by
// value because a ResizeObserver on the panels fires while the panels are still
// settling, and re-rendering on a sub-pixel wobble would keep it firing forever.
function layoutSignature(layout) {
    if (!layout) return ''
    const { geometry, stops } = layout
    return [
        Math.round(geometry.top), Math.round(geometry.left), Math.round(geometry.height),
        Math.round(geometry.minScroll), Math.round(geometry.maxScroll),
        ...stops.map((stop) => `${stop.key}:${Math.round(stop.offset)}`),
    ].join('|')
}

/**
 * The genome browser's scroll bar.
 *
 * The app's own scrollbar is a few pixels of overlay on the far right, which is
 * a poor handle for a page that is several genomes tall — and it says nothing
 * about what is on it. This replaces it with a permanent rail down the left
 * gutter, drawn in the Cycle wheel's language: one coloured dot per *active*
 * genome, and a ring for where the page is.
 *
 * The ring and the dots share one coordinate system with the Cycle wheel's Jump,
 * so "the ring is over the mouse dot" and "the mouse control bar is against the
 * top bar" are the same statement. Clicking a dot runs that same Jump.
 *
 * With a single genome there is one dot and the rail is simply a scroll bar —
 * still worth having, because one genome with every transcript expanded is an
 * easy three screens tall.
 */
export default function BrowserScrollRail({ panels, hostRef, overlayRef, onJump, isActive, isLight }) {
    const railRef = useRef(null)
    const indicatorRef = useRef(null)
    const readoutRef = useRef(null)
    const scrollerRef = useRef(null)
    const layoutRef = useRef(null)
    const scrollTopRef = useRef(0)
    const dragRef = useRef(null)
    const [layout, setLayout] = useState(null)
    // Only what the rail actually renders from, so a scroll frame that moves the
    // ring without changing which genome is current costs no render at all.
    const [position, setPosition] = useState({ index: 0, percent: 0 })
    const [engaged, setEngaged] = useState(false)
    const hasLayout = layout !== null

    const measure = useCallback(() => {
        const host = hostRef.current
        const scroller = host ? findScrollHost(host) : null
        scrollerRef.current = scroller
        if (!isActive || !scroller || !panels.length) {
            layoutRef.current = null
            setLayout((prev) => (prev ? null : prev))
            return
        }
        const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
        const hostRect = scroller.getBoundingClientRect()
        // The general control bar covers the top of the page while it is
        // unlocked, so a genome parked "at the top" sits under it, not behind it.
        // Locked, it scrolls away instead, and the inset is zero — which is what
        // makes the first genome's own alignment the right floor for the rail in
        // either mode, rather than any fixed number of pixels.
        const inset = stickyControlsInset(overlayRef.current)
        const measured = panels.map((panel) => {
            const anchor = panelAlignmentAnchor(host, panel.key)
            if (!anchor) return null
            return {
                ...panel,
                scrollTop: anchor.getBoundingClientRect().top - hostRect.top + scroller.scrollTop - inset,
            }
        }).filter((stop) => stop && Number.isFinite(stop.scrollTop))
        if (!measured.length || hostRect.height < 80) {
            layoutRef.current = null
            setLayout((prev) => (prev ? null : prev))
            return
        }
        const geometry = scrollRailGeometry(hostRect, {
            maxScroll,
            minScroll: Math.min(...measured.map((stop) => stop.scrollTop)),
        })
        if (geometry.span < SCROLL_RAIL_MIN_OVERFLOW) {
            layoutRef.current = null
            setLayout((prev) => (prev ? null : prev))
            return
        }
        const stops = placeScrollRailStops(measured, geometry)
        const next = { geometry, stops }
        setLayout((prev) => (layoutSignature(prev) === layoutSignature(next) ? prev : next))
        layoutRef.current = next
    }, [hostRef, overlayRef, isActive, panels])

    // Panels grow for a while after they mount as their tracks lay out, which
    // moves every dot below them, so the rail is remeasured from the page rather
    // than computed once when the genome list changes.
    useEffect(() => {
        const host = hostRef.current
        if (!host) return undefined
        let frame = 0
        const schedule = () => {
            if (frame) return
            frame = requestAnimationFrame(() => { frame = 0; measure() })
        }
        const observer = new ResizeObserver(schedule)
        observer.observe(host)
        const scroller = findScrollHost(host)
        if (scroller) observer.observe(scroller)
        window.addEventListener('resize', schedule)
        // The observer delivers a first reading of its own, so this only covers
        // the case where nothing about the page has changed but the rail's
        // inputs have — a genome added, or the view becoming the active one.
        schedule()
        return () => {
            if (frame) cancelAnimationFrame(frame)
            observer.disconnect()
            window.removeEventListener('resize', schedule)
        }
    }, [measure, hostRef])

    // The ring is written straight to the DOM rather than rendered: it moves on
    // every scroll frame, and re-rendering five dots and a readout with it would
    // make dragging the rail cost more than the page it is scrolling.
    const syncRing = useCallback(() => {
        const current = layoutRef.current
        const scroller = scrollerRef.current
        if (!current || !scroller) return
        const top = scroller.scrollTop
        scrollTopRef.current = top
        const offset = railOffsetForScroll(top, current.geometry)
        if (indicatorRef.current) indicatorRef.current.style.top = `${offset}px`
        if (readoutRef.current) readoutRef.current.style.top = `${offset}px`
        const index = activeScrollRailStop(top, current.stops)
        const percent = current.geometry.maxScroll > 0
            ? Math.round((top / current.geometry.maxScroll) * 100)
            : 0
        setPosition((prev) => (prev.index === index && prev.percent === percent ? prev : { index, percent }))
    }, [])

    useEffect(() => {
        if (!layout) return undefined
        const scroller = scrollerRef.current
        if (!scroller) return undefined
        let frame = 0
        let settle = 0
        const onScroll = () => {
            // The dots move when a panel below the fold finishes laying its
            // tracks out, which is exactly when scrolling has stopped. Reading
            // the page on every frame of a drag would cost a forced layout per
            // frame for an answer that almost never changes mid-gesture.
            clearTimeout(settle)
            settle = setTimeout(measure, 120)
            if (frame) return
            frame = requestAnimationFrame(() => { frame = 0; syncRing() })
        }
        scroller.addEventListener('scroll', onScroll, { passive: true })
        return () => {
            if (frame) cancelAnimationFrame(frame)
            clearTimeout(settle)
            scroller.removeEventListener('scroll', onScroll)
        }
    }, [layout, syncRing, measure])

    useLayoutEffect(syncRing, [layout, syncRing])

    const scrollTo = useCallback((value) => {
        const scroller = scrollerRef.current
        if (!scroller) return
        scroller.scrollTop = Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight, value))
        syncRing()
    }, [syncRing])

    // A wheel over the rail scrolls the page it represents. The rail is fixed
    // outside the scroll container, so without this the gesture would land on
    // nothing at all — which is exactly the complaint the rail exists to answer.
    useEffect(() => {
        const rail = railRef.current
        if (!rail) return undefined
        const onWheel = (event) => {
            const scroller = scrollerRef.current
            if (!scroller) return
            event.preventDefault()
            const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroller.clientHeight : 1
            scrollTo(scroller.scrollTop + event.deltaY * scale)
        }
        rail.addEventListener('wheel', onWheel, { passive: false })
        return () => rail.removeEventListener('wheel', onWheel)
    }, [hasLayout, scrollTo])

    const handlePointerDown = useCallback((event) => {
        const current = layoutRef.current
        const rail = railRef.current
        if (event.button !== 0 || !current || !rail) return
        const stopKey = event.target?.closest?.('[data-rail-stop]')?.getAttribute('data-rail-stop') || null
        const offset = event.clientY - rail.getBoundingClientRect().top
        const ring = railOffsetForScroll(scrollTopRef.current, current.geometry)
        // Pressing the ring picks it up where it stands; pressing bare track
        // throws the page to that position and then drags from there.
        const grabbing = !stopKey && Math.abs(offset - ring) <= SCROLL_RAIL_GRAB
        event.preventDefault()
        rail.setPointerCapture?.(event.pointerId)
        dragRef.current = {
            pointerId: event.pointerId,
            stopKey,
            moved: false,
            originY: event.clientY,
            delta: grabbing ? ring - offset : 0,
        }
        setEngaged(true)
        if (!stopKey && !grabbing) scrollTo(scrollForRailOffset(offset, current.geometry))
    }, [scrollTo])

    const handlePointerMove = useCallback((event) => {
        const drag = dragRef.current
        const current = layoutRef.current
        const rail = railRef.current
        if (!drag || !current || !rail || event.pointerId !== drag.pointerId) return
        // A press that travels is a drag wherever it began — including on a dot,
        // which then scrolls rather than jumping when it is let go.
        if (!drag.moved && Math.abs(event.clientY - drag.originY) > CYCLE_DRAG_THRESHOLD) {
            drag.moved = true
            drag.stopKey = null
        }
        if (drag.stopKey) return
        scrollTo(scrollForRailOffset(event.clientY - rail.getBoundingClientRect().top + drag.delta, current.geometry))
    }, [scrollTo])

    const endDrag = useCallback((event, commit) => {
        const drag = dragRef.current
        if (!drag || event.pointerId !== drag.pointerId) return
        dragRef.current = null
        setEngaged(false)
        railRef.current?.releasePointerCapture?.(event.pointerId)
        if (commit && drag.stopKey && !drag.moved) onJump?.(drag.stopKey)
    }, [onJump])

    const handleKeyDown = useCallback((event) => {
        const current = layoutRef.current
        const scroller = scrollerRef.current
        if (!current || !scroller) return
        const page = Math.max(120, scroller.clientHeight * PAGE_FRACTION)
        const jumpTo = (index) => {
            const stop = current.stops[index]
            if (stop) onJump?.(stop.key)
        }
        const genomeStep = (direction) => {
            event.preventDefault()
            jumpTo(stepScrollRailStop(scrollTopRef.current, current.stops, direction))
        }
        switch (event.key) {
            case 'ArrowUp':
                if (event.shiftKey) return genomeStep(-1)
                event.preventDefault()
                return scrollTo(scroller.scrollTop - ARROW_STEP)
            case 'ArrowDown':
                if (event.shiftKey) return genomeStep(1)
                event.preventDefault()
                return scrollTo(scroller.scrollTop + ARROW_STEP)
            case 'ArrowLeft':
                return genomeStep(-1)
            case 'ArrowRight':
                return genomeStep(1)
            case 'PageUp':
                event.preventDefault()
                return scrollTo(scroller.scrollTop - page)
            case 'PageDown':
                event.preventDefault()
                return scrollTo(scroller.scrollTop + page)
            case 'Home':
                event.preventDefault()
                return scrollTo(current.geometry.minScroll)
            case 'End':
                event.preventDefault()
                return scrollTo(current.geometry.maxScroll)
            default:
                return undefined
        }
    }, [onJump, scrollTo])

    if (!layout) return null
    const { geometry, stops } = layout
    const { index: activeIndex, percent } = position
    const active = stops[activeIndex] || stops[0]

    return createPortal(
        <div
            ref={railRef}
            className={`browser-scroll-rail ${isLight ? 'light' : ''} ${engaged ? 'engaged' : ''}`}
            style={{ top: geometry.top, left: geometry.left, height: geometry.height, width: SCROLL_RAIL_WIDTH }}
            // Chrome, not track surface: the view's wheel router and its
            // drag-to-scroll both stand down over anything marked this way.
            data-browser-controls="true"
            data-tour-id="browser-scroll-rail"
            role="slider"
            aria-orientation="vertical"
            aria-label="Browser position"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-valuetext={active ? `${percent}% — ${active.label}` : `${percent}%`}
            tabIndex={0}
            title={'Drag to scroll the browser, or click a genome to jump to it.\nKeyboard: ↑ ↓ scroll · ← → genome · Page Up/Down · Home/End'}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={(event) => endDrag(event, true)}
            onPointerCancel={(event) => endDrag(event, false)}
            onLostPointerCapture={(event) => endDrag(event, false)}
            onKeyDown={handleKeyDown}
            onContextMenu={(event) => event.preventDefault()}
        >
            <div className="browser-scroll-rail-line" style={{ top: geometry.padding, bottom: geometry.padding }} />
            {/* One tinted segment per genome, so the rail reads as a map of the
                page — how much of it each genome takes up — and not only as a
                row of dots. The last runs to the end of the track, which is the
                whitespace kept under the final panel so it too can reach the top. */}
            {stops.map((stop, index) => (
                <div
                    key={`band-${stop.key}`}
                    className={`browser-scroll-rail-band ${index === activeIndex ? 'current' : ''}`}
                    style={{
                        top: stop.offset,
                        height: Math.max(0, (stops[index + 1]?.offset ?? geometry.padding + geometry.track) - stop.offset),
                        backgroundColor: stop.color,
                    }}
                />
            ))}
            {/* Real buttons, as on the Cycle rail, so a genome can be reached by
                pressing it. Hidden from the reading order: the rail itself is the
                slider and already announces where the page is and which genome
                that is. */}
            {stops.map((stop, index) => (
                <button
                    key={stop.key}
                    type="button"
                    tabIndex={-1}
                    aria-hidden="true"
                    data-rail-stop={stop.key}
                    data-tour-id={`browser-scroll-rail-genome-${stop.tourId || stop.key}`}
                    className={`browser-scroll-rail-stop ${index === activeIndex ? 'current' : ''}`}
                    style={{ top: stop.offset, '--dot': stop.color }}
                    title={`Jump to ${stop.label}`}
                >
                    <span className="browser-scroll-rail-stop-label">{stop.label}</span>
                </button>
            ))}
            <span
                ref={indicatorRef}
                className="browser-scroll-rail-indicator"
            />
            <div
                ref={readoutRef}
                className="browser-scroll-rail-readout"
            >
                {active?.label}
            </div>
        </div>,
        document.body,
    )
}

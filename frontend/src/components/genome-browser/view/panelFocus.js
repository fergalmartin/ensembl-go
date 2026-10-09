// Focus within the Genome Browser view: selecting a panel's gene, the detail
// transcript, aligning a panel to the top and moving a pinned alignment.
import { flushSync } from 'react-dom'
import { findScrollHost, panelAlignmentAnchor, stickyControlsInset } from '../../../utils/browserScrollRail.js'

export function movePinnedAlignment(ctx, panel, from, to, scrollDistance = null) {
    const {
        findPanelScroller,
        pinAnimationRef,
        setFocusDrawerPinOffset,
        stopPinAnimation,
    } = ctx
        stopPinAnimation()
        const distance = to - from
        const travel = scrollDistance === null ? distance : scrollDistance
        if (!distance && !travel) return

        const scroller = findPanelScroller(panel)
        const drawer = panel.closest('[data-focus-panel-wrapper]')
            ?.querySelector('[data-focus-drawer-body="true"]')
        const scrollTo = (value) => {
            if (!scroller) return
            scroller.scrollTop = Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight, value))
        }
        if (!scroller || !drawer) {
            setFocusDrawerPinOffset(to)
            if (scroller) scrollTo(scroller.scrollTop + travel)
            else window.scrollBy(0, travel)
            return
        }

        // Flushed, so the settled offset and the transform that walks back to the
        // starting position land in the same paint. Left to batch, React commits
        // the offset a frame early and the list jumps the whole distance before
        // sliding back.
        //
        // The offset itself is a margin now, so the transform is free to carry
        // the animation as a correction that decays to nothing.
        const settled = ''
        flushSync(() => setFocusDrawerPinOffset(to))
        drawer.style.transform = `translateY(${-distance}px)`

        const scrollFrom = scroller.scrollTop
        const duration = Math.min(520, Math.max(220, Math.max(Math.abs(distance), Math.abs(travel)) * 1.5))
        const started = performance.now()
        const step = (now) => {
            const t = Math.min(1, (now - started) / duration)
            const eased = 1 - ((1 - t) ** 3)
            scrollTo(scrollFrom + (travel * eased))
            if (t < 1) {
                drawer.style.transform = `translateY(${-distance * (1 - eased)}px)`
                pinAnimationRef.current = { frame: requestAnimationFrame(step), drawer, settled }
                return
            }
            drawer.style.transform = settled
            pinAnimationRef.current = null
        }
        pinAnimationRef.current = { frame: requestAnimationFrame(step), drawer, settled }
    }

export function changeDetailTranscript(ctx, panelKey, transcriptId) {
    const {
        detailScrollMemoryRef,
        detailTranscriptRef,
        findPanelScroller,
        screenshotOverlayRootRef,
        setDetailListShiftByPanel,
        setDetailTranscriptByPanel,
        setNotesPanelOpenByPanel,
    } = ctx
        const wasOpen = Boolean(detailTranscriptRef.current[panelKey])
        const willOpen = Boolean(transcriptId)
        setDetailTranscriptByPanel((prev) => ({ ...prev, [panelKey]: transcriptId }))
        // The detail and the notes share one wide slot. If both were ever open
        // the drawer's own width and the coverage the assembly drawer clears
        // would disagree, and the two panels would sit on top of each other.
        if (willOpen) setNotesPanelOpenByPanel((prev) => (prev[panelKey] ? { ...prev, [panelKey]: false } : prev))
        if (willOpen === wasOpen) return

        const wrapper = screenshotOverlayRootRef.current?.querySelector(
            `[data-focus-panel-wrapper="${CSS.escape(panelKey)}"]`
        )
        const drawer = wrapper?.querySelector('[data-focus-drawer="true"]')
        const scroller = drawer ? findPanelScroller(drawer) : null
        if (!drawer || !scroller) return
        const scrollTo = (value) => {
            scroller.scrollTop = Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight, value))
        }

        if (willOpen) {
            detailScrollMemoryRef.current[panelKey] = scroller.scrollTop
            const above = drawer.getBoundingClientRect().top - scroller.getBoundingClientRect().top
            // Only when its top has gone past — no need to move a detail that is
            // already showing from the beginning.
            if (above < 0) scrollTo(scroller.scrollTop + above)

            // Bring the transcript the detail is about to the top of the list, so
            // it is obvious which of twenty identifiers the panel is describing.
            // Deferred a frame: the drawer widens and the list offset drops as the
            // detail opens, and the row's position is only settled after that.
            requestAnimationFrame(() => {
                const row = wrapper.querySelector(
                    `[data-drawer-transcript-row="${CSS.escape(transcriptId)}"]`
                )
                const list = wrapper.querySelector('[data-focus-drawer-list="true"]')
                if (!row || !list) return
                const shift = Math.round(row.getBoundingClientRect().top - list.getBoundingClientRect().top)
                setDetailListShiftByPanel((prev) => ({ ...prev, [panelKey]: Math.max(0, shift) }))
            })
            return
        }

        setDetailListShiftByPanel((prev) => (prev[panelKey] ? { ...prev, [panelKey]: 0 } : prev))
        const remembered = detailScrollMemoryRef.current[panelKey]
        delete detailScrollMemoryRef.current[panelKey]
        if (Number.isFinite(remembered)) scrollTo(remembered)
    }

export function alignPanelToTopOfView(ctx, panelKey) {
    const {
        cycleScrollRef,
        screenshotOverlayRootRef,
        screenshotPanelsRef,
        stopCycleScroll,
    } = ctx
        if (!panelKey) return
        stopCycleScroll()
        const abandon = () => stopCycleScroll()
        window.addEventListener('wheel', abandon, true)
        window.addEventListener('pointerdown', abandon, true)
        // A genome that has just been added is not on the page yet, and once it
        // is its tracks keep laying out for a while afterwards. So the target is
        // remeasured every frame instead of being resolved once: the follow
        // waits for the panel to appear and then keeps closing on its control
        // bar while the panel grows underneath it.
        const deadline = performance.now() + 3000
        let previous = performance.now()
        let arrived = null
        const step = (now) => {
            const host = screenshotPanelsRef.current
            const scroller = host ? findScrollHost(host) : null
            const anchor = panelAlignmentAnchor(host, panelKey)
            if (scroller && anchor) {
                const inset = stickyControlsInset(screenshotOverlayRootRef.current)
                const gap = anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top - inset
                const eased = gap * (1 - Math.exp(-Math.min(64, now - previous) / 70))
                // The last few pixels go in one move. `scrollTop` is quantised, so
                // a step under a pixel is rounded away and the easing stalls just
                // short — leaving the genome resting under the top bar for good.
                const travel = Math.abs(eased) < 1 ? gap : eased
                scroller.scrollTop = Math.max(0, Math.min(
                    scroller.scrollHeight - scroller.clientHeight,
                    scroller.scrollTop + travel,
                ))
                // Held briefly after arriving, so a panel that is still laying its
                // tracks out cannot walk the bar back off the top; then the page is
                // the reader's again, well before the deadline.
                arrived = Math.abs(gap) <= 1 ? (arrived ?? now) : null
                if (arrived !== null && now - arrived > 250) return stopCycleScroll()
            }
            previous = now
            if (now >= deadline) return stopCycleScroll()
            cycleScrollRef.current = { frame: requestAnimationFrame(step), abandon }
        }
        cycleScrollRef.current = { frame: requestAnimationFrame(step), abandon }
    }

export function selectPanelGene(ctx, panelKey, gene) {
    const {
        geneTranscriptViews,
        resumeClosedDrawersRef,
        setDetailTranscriptByPanel,
        setFocusDrawerOpenByPanel,
        setFocusPanelOrder,
        setFocusTranscriptViews,
        setSelectedGenes,
    } = ctx
        setSelectedGenes((prev) => ({ ...prev, [panelKey]: gene || null }))
        const geneId = String(gene?.id || '').trim()
        setFocusTranscriptViews((prev) => {
            const current = prev[panelKey]
            if (!geneId) {
                if (!current) return prev
                const next = { ...prev }
                delete next[panelKey]
                return next
            }
            if (current?.geneId === geneId) return prev
            const remembered = geneTranscriptViews[panelKey]?.[geneId]
            return {
                ...prev,
                [panelKey]: {
                    geneId,
                    order: remembered?.order ?? null,
                    hidden: remembered?.hidden ?? [],
                    // null defers to whatever the panel already had expanded, so
                    // focusing an already-expanded gene does not collapse it.
                    expanded: remembered?.expanded ?? null,
                    ghostId: null,
                    hoverId: null,
                    pinnedId: null,
                },
            }
        })
        setFocusPanelOrder((prev) => {
            const without = prev.filter((key) => key !== panelKey)
            return geneId ? [panelKey, ...without] : without
        })
        // A fresh focus always presents that panel's drawer open, whatever the
        // user did with its collapse arrow last time.
        if (geneId) {
            const resumeClosed = resumeClosedDrawersRef.current.focus.delete(panelKey)
            setFocusDrawerOpenByPanel((prev) => ({ ...prev, [panelKey]: !resumeClosed }))
        } else setDetailTranscriptByPanel((prev) => ({ ...prev, [panelKey]: '' }))
    }

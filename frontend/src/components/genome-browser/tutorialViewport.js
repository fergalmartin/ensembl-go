// Registering a Genome Browser panel with the tutorial engine: the viewport
// operations a tutorial step can drive (go to a locus or gene, pan, zoom, frame a
// focus), run as the panel's effect.
import { registerBrowserViewport } from '../../utils/browserTutorialControls.js'
import { TUTORIAL_MOVE_MS } from './browserConstants.js'
import { getFocusLocationRange, isSameChromToken } from './genomeBrowserViewportLayout.js'

export function registerTutorialViewport(ctx) {
    const {
        animateToView,
        browsableRange,
        chromDisplayMap,
        focusLocation,
        focusLocationRange,
        frameFocusRange,
        genome,
        hiddenStrands,
        interactionModeRef,
        isLocationFocusVisible,
        regions,
        rootRef,
        screenshotTargetId,
        selectedChrom,
        selectedGene,
        selectedLocation,
        setHiddenStrands,
        tutorialRecipeId,
        tutorialSequenceVisibleRef,
        viewEndRef,
        viewStartRef,
    } = ctx
        const panelKey = String(screenshotTargetId || genome || '')
        if (!panelKey) return undefined
        const span = () => Math.max(1, viewEndRef.current - viewStartRef.current)
        const duration = (ms) => (Number(ms) > 0 ? Number(ms) : TUTORIAL_MOVE_MS)
        const bare = (name) => String(name || '').trim().toLowerCase().replace(/^chr/, '')

        return registerBrowserViewport(panelKey, {
            recipeId: tutorialRecipeId,
            frameFocusedRange: (start, end) => frameFocusRange(start, end, { gainingFocus: true }),
            setTracks: (tracks) => setHiddenStrands((prev) => ({ ...prev, ...Object.fromEntries(Object.entries(tracks).map(([key, visible]) => [key, !visible])) })),
            setInteraction: (mode) => { interactionModeRef.current = mode },
            resetScroll: () => {
                // The panel lives inside the view's scroller, not its own, so this walks
                // up to whatever is actually scrolling.
                let node = rootRef.current
                while (node && node !== document.body) {
                    if (node.scrollHeight > node.clientHeight + 1) { node.scrollTop = 0; return }
                    node = node.parentElement
                }
            },
            describe: () => ({
                chrom: selectedChrom,
                start: viewStartRef.current,
                end: viewEndRef.current,
                sequenceVisible: tutorialSequenceVisibleRef.current,
                bounds: browsableRange,
                tracks: Object.fromEntries(Object.entries(hiddenStrands).map(([key, hidden]) => [key, !hidden])),
                focus: selectedGene?.name || selectedGene?.id || '',
                // The location of focus, so an arrival can tell "already right" from
                // "needs setting" rather than re-focusing on every visit to a step.
                locationFocus: isLocationFocusVisible && focusLocationRange
                    ? { ...focusLocationRange }
                    : null,
                ready: Boolean(selectedChrom && regions.length),
            }),
            // The location of focus, set the way the gene of focus is: through the panel's
            // own handler rather than behind it, so the drawer, the focus bar, the boundary
            // lines and the gene that gives way to it all stay in step.
            //
            // Deliberately not "press the Focus this window button": that control focuses
            // whatever the window happens to be showing, so a step wanting a particular
            // region would have to travel there first and then be moved back — a journey
            // and a correction, which is exactly what docs/TUTORIALS.md says a tutorial
            // must not do. This leaves the view alone; the step's own `browserView`
            // arrival puts it where the card describes, in one move.
            setLocationFocus: (range) => {
                if (!range) {
                    if (!selectedLocation) return false
                    focusLocation(null)
                    return true
                }
                const wanted = getFocusLocationRange(range)
                if (!wanted) return false
                if (!isSameChromToken(wanted.chrom, selectedChrom)) return false
                const current = focusLocationRange
                if (current
                    && isSameChromToken(current.chrom, wanted.chrom)
                    && Math.round(current.start) === Math.round(wanted.start)
                    && Math.round(current.end) === Math.round(wanted.end)) return false
                focusLocation(wanted)
                return true
            },
            panByWindows: (fraction, ms) => {
                const shift = span() * (Number(fraction) || 0)
                if (!shift) return false
                animateToView(viewStartRef.current + shift, viewEndRef.current + shift, duration(ms))
                return true
            },
            zoomBy: (factor, ms) => {
                const value = Number(factor)
                if (!(value > 0)) return false
                const centre = viewStartRef.current + (span() / 2)
                const next = Math.max(2, span() * value)
                animateToView(centre - (next / 2), centre + (next / 2), duration(ms))
                return true
            },
            goToLocus: (text, ms) => {
                const parsed = String(text || '').match(/^\s*([^:\s]+)\s*:\s*([\d,\s]+)\s*-\s*([\d,\s]+)\s*$/)
                if (!parsed) return false
                const start = parseInt(parsed[2].replace(/[,\s]/g, ''), 10)
                const end = parseInt(parsed[3].replace(/[,\s]/g, ''), 10)
                if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return false
                // A locus on some other region is not a move, it is a navigation — leave
                // that to the search box, which knows how to switch region.
                const showing = chromDisplayMap[selectedChrom] || selectedChrom
                if (bare(parsed[1]) !== bare(showing) && bare(parsed[1]) !== bare(selectedChrom)) return false
                // Through the same framing every other "put this on screen" path uses, so
                // a locus a tutorial asks for lands in the part of the track the reader can
                // actually see. Without it a step that names a region around the focused
                // gene centres that gene behind the drawer — the drawer overlays the canvas
                // rather than narrowing it, so the window itself never shrank. A no-op
                // whenever no drawer is open, since the inset is then zero.
                const framed = frameFocusRange(start, end)
                animateToView(framed.start, framed.end, duration(ms))
                return true
            },
        })
    }

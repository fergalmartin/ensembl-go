import { useRef, useEffect, useState, useCallback, useMemo } from 'react'
import { FEATURE_COLORS } from './FeatureLegend'
import { isTextEntryTarget, normalizeWheelDelta, wheelZoomFactor } from '../utils/browsingControls'
import { monoFont } from '../utils/typography'

const CHAR_HEIGHT = 16
const ROW_HEIGHT = 24
const HEADER_HEIGHT = 40
const CDS_STRIPE_COLORS = ['#60a5fa', '#bfdbfe']

function hexLuminance(hexColor) {
    const hex = String(hexColor || '').replace('#', '')
    if (hex.length !== 6) return 0
    const r = parseInt(hex.slice(0, 2), 16) / 255
    const g = parseInt(hex.slice(2, 4), 16) / 255
    const b = parseInt(hex.slice(4, 6), 16) / 255
    return (0.2126 * r) + (0.7152 * g) + (0.0722 * b)
}

export default function AlignmentPanel({
    alignment,
    collapseIntrons,
    collapseSource,  // 'reference' or 'target'
    theme,
    activeTargetId = null,
    activeRefId = null,
    refTag = 'G1',
    tgtTag = 'G2',
}) {
    const canvasRef = useRef(null)
    const containerRef = useRef(null)
    const [scrollX, setScrollX] = useState(0)
    const [viewWidth, setViewWidth] = useState(800)
    const [isDragging, setIsDragging] = useState(false)
    const [dragStart, setDragStart] = useState(0)
    const [zoomLevel, setZoomLevel] = useState(1.0)  // 1.0 = max zoom (current), 0.1 = zoomed way out

    // Fling/momentum physics state
    const velocityRef = useRef(0)
    const lastPosRef = useRef(0)
    const lastTimeRef = useRef(0)
    const animationRef = useRef(null)

    // Zoom constants
    const BASE_CHAR_WIDTH = 10  // Width at zoom level 1.0
    const MIN_ZOOM = 0.02       // Minimum zoom level (allows ~25% of alignment visible)
    const MAX_ZOOM = 2.0        // Increased max zoom to allow magnification beyond default 100%
    const BLOCK_THRESHOLD = 0.3 // Below this zoom, render blocks instead of characters

    // Computed character width based on zoom
    const CHAR_WIDTH = BASE_CHAR_WIDTH * zoomLevel

    const INTRON_EDGE_BP = 10  // Keep 10bp at each intron edge

    // Process alignment for collapsed view
    const processAlignment = useCallback(() => {
        const refFeatures = alignment.reference.features
        const tgtFeatures = alignment.target.features
        const refSeq = alignment.reference.sequence
        const tgtSeq = alignment.target.sequence

        // Determine which positions to keep
        const positionsToKeep = new Set()
        let useCollapsing = false
        const gapMarkers = []  // Track where gaps are inserted

        if (collapseIntrons) {
            useCollapsing = true
            // Use features from the selected source for collapse calculation
            const sourceFeatures = collapseSource === 'reference' ? refFeatures : tgtFeatures
            const intronRanges = sourceFeatures.filter(f => f.type === 'intron')

            // Start with all positions kept
            for (let i = 0; i < alignment.alignment_length; i++) positionsToKeep.add(i)

            // Remove positions in middle of introns
            for (const intron of intronRanges) {
                const intronStart = intron.start
                const intronEnd = intron.end
                const intronLen = intronEnd - intronStart + 1

                // If intron is short, keep it all
                if (intronLen <= INTRON_EDGE_BP * 2) {
                    continue
                }

                // Mark middle positions for removal
                const collapseStart = intronStart + INTRON_EDGE_BP
                const collapseEnd = intronEnd - INTRON_EDGE_BP

                for (let pos = collapseStart; pos <= collapseEnd; pos++) {
                    positionsToKeep.delete(pos)
                }

                // Record gap marker (positioned after the first edge)
                gapMarkers.push({
                    afterOldPos: collapseStart - 1,
                    collapsedCount: collapseEnd - collapseStart + 1
                })
            }
        }

        // Return simpler object if filtering didn't happen to save memory/time
        if (!useCollapsing) {
            return {
                refSeq: alignment.reference.sequence,
                tgtSeq: alignment.target.sequence,
                refFeatures: refFeatures,
                tgtFeatures: tgtFeatures,
                visibleLength: alignment.alignment_length,
                positionMap: null, // No mapping needed
                gapMarkers: []
            }
        }

        // Build filtered sequences and position mapping
        let newRefSeq = ''
        let newTgtSeq = ''
        const oldToNew = new Map()
        const collapsedGaps = []  // {newPosition, count}

        let newPos = 0
        for (let oldPos = 0; oldPos < alignment.alignment_length; oldPos++) {
            if (positionsToKeep.has(oldPos)) {
                // Check if we need to insert a gap marker here
                // Iterate gapMarkers to see if one belongs here
                // This logic was incorrect in the original, now handled after oldToNew is built.

                newRefSeq += refSeq[oldPos] || ''
                newTgtSeq += tgtSeq[oldPos] || ''
                oldToNew.set(oldPos, newPos)
                newPos++
            }
        }

        // Re-process gap markers to map them to new coordinates
        for (const marker of gapMarkers) {
            // Check if the position AFTER the break exists in new map OR is the end
            // The break is at marker.afterOldPos.
            // We want to draw the marker AFTER the character at oldToNew.get(marker.afterOldPos)
            if (oldToNew.has(marker.afterOldPos)) {
                collapsedGaps.push({
                    position: oldToNew.get(marker.afterOldPos) + 1, // Draw AFTER this base
                    count: marker.collapsedCount
                })
            }
        }

        // Remap features to new positions
        const remapFeatures = (features) => {
            return features.map(f => {
                let newStart = null
                let newEnd = null

                for (let pos = f.start; pos <= f.end; pos++) {
                    if (oldToNew.has(pos)) {
                        if (newStart === null) newStart = oldToNew.get(pos)
                        newEnd = oldToNew.get(pos)
                    }
                }

                if (newStart === null) return null

                return {
                    ...f,
                    start: newStart,
                    end: newEnd
                }
            }).filter(f => f !== null)
        }

        return {
            refSeq: newRefSeq,
            tgtSeq: newTgtSeq,
            refFeatures: remapFeatures(refFeatures),
            tgtFeatures: remapFeatures(tgtFeatures),
            visibleLength: newRefSeq.length,
            positionMap: oldToNew,
            gapMarkers: collapsedGaps
        }
    }, [alignment, collapseIntrons, collapseSource])

    // Track previous props to detect collapse changes
    const prevCollapseIntrons = usePrevious(collapseIntrons)
    const prevCollapseSource = usePrevious(collapseSource)
    const [prevPositionMap, setPrevPositionMap] = useState(null)

    // Helper hook to track previous value
    function usePrevious(value) {
        const ref = useRef()
        useEffect(() => {
            ref.current = value
        })
        return ref.current
    }

    const { refSeq, tgtSeq, refFeatures, tgtFeatures, visibleLength, gapMarkers, positionMap } = processAlignment()

    // Calculate maxScroll consistently in render body
    const maxScroll = Math.max(0, visibleLength * CHAR_WIDTH - viewWidth + 50)

    // Effect to handle scroll position preservation when toggling collapse
    // AND to clamp scroll when maxScroll reduces
    useEffect(() => {
        const hasToggled = (collapseIntrons !== prevCollapseIntrons) || (collapseSource !== prevCollapseSource)

        if (hasToggled && prevPositionMap !== undefined) {
            // Calculate current central alignment index (absolute) based on previous mapping
            const currentCenterViewIdx = Math.floor((scrollX + viewWidth / 2) / CHAR_WIDTH)
            let absoluteIdx = currentCenterViewIdx

            // If we were previously collapsed, we need to find what absolute index corresponds to our view index
            if (prevCollapseIntrons) {
                // Reverse lookup in prevPositionMap (New -> Old)
                for (const [oldIdx, newIdx] of prevPositionMap.entries()) {
                    if (newIdx === currentCenterViewIdx) {
                        absoluteIdx = oldIdx
                        break
                    }
                }
            }

            // Now calculating the NEW view index for this absolute index
            let newViewIdx = absoluteIdx
            if (positionMap) {
                if (positionMap.has(absoluteIdx)) {
                    newViewIdx = positionMap.get(absoluteIdx)
                } else {
                    // If exact index is gone (collapsed), find nearest
                    let minDist = Infinity
                    for (const [oldIdx, newIdx] of positionMap.entries()) {
                        const dist = Math.abs(oldIdx - absoluteIdx)
                        if (dist < minDist) {
                            minDist = dist
                            newViewIdx = newIdx
                        }
                    }
                }
            }

            // Update scroll to center this new index
            const newScroll = Math.max(0, newViewIdx * CHAR_WIDTH - viewWidth / 2)
            setScrollX(Math.min(newScroll, maxScroll))
        } else {
            // Just clamp if scrollX is out of bounds (e.g. window resize or simple collapse update)
            if (scrollX > maxScroll) {
                setScrollX(maxScroll)
            }
        }

        // Update prev map for next time
        setPrevPositionMap(positionMap)

    }, [collapseIntrons, collapseSource, positionMap, prevCollapseIntrons, prevCollapseSource, scrollX, visibleLength, viewWidth, maxScroll])

    // Handle resize
    useEffect(() => {
        const updateWidth = () => {
            if (containerRef.current) {
                setViewWidth(containerRef.current.clientWidth)
            }
        }
        updateWidth()
        window.addEventListener('resize', updateWidth)
        return () => window.removeEventListener('resize', updateWidth)
    }, [])

    // Get feature at position
    const getFeatureAt = (features, pos) => {
        for (const f of features) {
            if (pos >= f.start && pos <= f.end) {
                return f
            }
        }
        return null
    }

    const buildCdsStripeMap = useCallback((features, seq) => {
        const list = Array.isArray(features) ? features : []
        const cdsRanges = list
            .filter((f) => f?.type === 'cds')
            .map((f) => ({
                start: Number(f?.start),
                end: Number(f?.end),
            }))
            .filter((f) => Number.isFinite(f.start) && Number.isFinite(f.end))
            .map((f) => ({ start: Math.min(f.start, f.end), end: Math.max(f.start, f.end) }))
            .sort((a, b) => a.start - b.start || a.end - b.end)
        if (cdsRanges.length === 0) return null

        const starts = list
            .filter((f) => f?.type === 'start_codon')
            .map((f) => ({
                start: Number(f?.start),
                end: Number(f?.end),
            }))
            .filter((f) => Number.isFinite(f.start) && Number.isFinite(f.end))
            .map((f) => ({ start: Math.min(f.start, f.end), end: Math.max(f.start, f.end) }))
            .sort((a, b) => a.start - b.start || a.end - b.end)

        let anchor = null
        for (const sc of starts) {
            if (seq) {
                const codon = String(seq.substring(sc.start, sc.end + 1) || '').toUpperCase()
                if (codon !== 'ATG') continue
            }
            const insideCds = cdsRanges.some((r) => sc.start >= r.start && sc.end <= r.end)
            if (insideCds) {
                anchor = sc.start
                break
            }
        }
        if (anchor === null) anchor = cdsRanges[0].start

        const stripeMap = new Map()
        let cdsBaseIndex = 0
        let started = false
        for (const range of cdsRanges) {
            for (let pos = range.start; pos <= range.end; pos++) {
                if (!started) {
                    if (pos < anchor) continue
                    started = true
                }
                const codonPhase = Math.floor(cdsBaseIndex / 3) % 2
                stripeMap.set(pos, CDS_STRIPE_COLORS[codonPhase])

                const base = String(seq?.[pos] || '')
                if (base !== '-') cdsBaseIndex += 1
            }
        }
        return stripeMap
    }, [])

    const refCdsStripeMap = useMemo(() => buildCdsStripeMap(refFeatures, refSeq), [buildCdsStripeMap, refFeatures, refSeq])
    const tgtCdsStripeMap = useMemo(() => buildCdsStripeMap(tgtFeatures, tgtSeq), [buildCdsStripeMap, tgtFeatures, tgtSeq])

    // Get color for position - returns highest priority feature color
    const getColorAt = (features, pos, seq, cdsStripeMap = null) => {
        // Features are sorted with lowest priority first (exon/intron) 
        // and highest priority last (start/stop/splice)
        // So iterate in reverse to find highest priority match
        for (let i = features.length - 1; i >= 0; i--) {
            const f = features[i]
            if (pos >= f.start && pos <= f.end) {
                // If it's a stop codon, verify it's canonical
                if (f.type === 'stop_codon' && seq) {
                    const codon = seq.substring(f.start, f.end + 1).toUpperCase()
                    if (!['TAA', 'TAG', 'TGA'].includes(codon)) {
                        continue // Not canonical, skip to next priority (e.g. exon)
                    }
                }
                if (f.type === 'cds' && cdsStripeMap?.has(pos)) {
                    return cdsStripeMap.get(pos)
                }
                const colorDef = FEATURE_COLORS[f.type]
                if (colorDef) return colorDef.bg
            }
        }
        return '#2d3748'  // Default dark gray (intergenic)
    }

    // Pre-calculate variation positions for minimap markers
    const variationMarkers = useMemo(() => {
        if (!refSeq || !tgtSeq) return []

        const WINDOW_SIZE = 100  // Group variations into 100bp windows
        const DENSE_THRESHOLD = 5  // >5 variations = dense region

        // Count variations per window
        const windowCounts = new Map()  // windowStart -> {count, positions}

        for (let i = 0; i < refSeq.length; i++) {
            const refBase = refSeq[i] || ''
            const tgtBase = tgtSeq[i] || ''

            // Check for mismatch or gap
            if (refBase !== tgtBase || refBase === '-' || tgtBase === '-') {
                if (!(refBase === tgtBase && refBase === '-')) {  // Skip double gaps
                    const windowStart = Math.floor(i / WINDOW_SIZE) * WINDOW_SIZE
                    if (!windowCounts.has(windowStart)) {
                        windowCounts.set(windowStart, { count: 0, positions: [] })
                    }
                    const window = windowCounts.get(windowStart)
                    window.count++
                    window.positions.push(i)
                }
            }
        }

        // Convert to markers
        const markers = []
        for (const [windowStart, data] of windowCounts) {
            if (data.count > DENSE_THRESHOLD) {
                // Dense region - create a block
                const start = data.positions[0]
                const end = data.positions[data.positions.length - 1]
                markers.push({
                    type: 'block',
                    start: start,
                    end: end,
                    count: data.count
                })
            } else {
                // Isolated variations - create triangles
                for (const pos of data.positions) {
                    markers.push({
                        type: 'triangle',
                        position: pos
                    })
                }
            }
        }

        return markers
    }, [refSeq, tgtSeq])


    // Draw canvas
    useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas) return

        const ctx = canvas.getContext('2d')
        const dpr = window.devicePixelRatio || 1
        const isLight = theme === 'light'

        const LABEL_W = 40  // px reserved on left for row labels

        // Set canvas size
        const canvasHeight = HEADER_HEIGHT + 3 * ROW_HEIGHT + 20
        canvas.width = viewWidth * dpr
        canvas.height = canvasHeight * dpr
        canvas.style.width = `${viewWidth}px`
        canvas.style.height = `${canvasHeight}px`
        ctx.scale(dpr, dpr)

        // Clear with theme-appropriate background
        const panelBg = isLight ? '#f3f4f6' : '#1a202c'  // grey-100 for light, dark for dark
        ctx.fillStyle = panelBg
        ctx.fillRect(0, 0, viewWidth, canvasHeight)
        // Keep label strip unfilled so G-labels blend with surrounding panel background.
        ctx.clearRect(0, 0, LABEL_W, canvasHeight)
        const GAP_COLOR = '#ef4444'

        // Calculate visible range
        const visibleChars = Math.floor(viewWidth / CHAR_WIDTH)
        const startPos = Math.floor(scrollX / CHAR_WIDTH)
        const endPos = Math.min(startPos + visibleChars + 2, visibleLength)

        // Rendering mode based on zoom level
        const useBlockMode = zoomLevel < BLOCK_THRESHOLD

        // Draw header - adjust tick spacing based on zoom (wider spacing at lower zoom)
        // At min zoom (0.02), characters are 0.2px wide, so need very wide spacing
        const tickSpacing = zoomLevel < 0.05 ? 500 : zoomLevel < 0.1 ? 250 : zoomLevel < 0.2 ? 100 : zoomLevel < 0.5 ? 50 : 10
        ctx.fillStyle = isLight ? '#4b5563' : '#4a5568'  // grey-600 for light
        ctx.font = monoFont(11)
        // Align to 1-based multiples of tickSpacing (10, 20, 30...) rather than
        // 0-based multiples (0, 10, 20... → "1, 11, 21...").
        // Ticks use the same +LABEL_W offset as all sequence content so they align
        // with their corresponding bases and stay out of the row-label zone.
        const firstTick = Math.ceil((startPos + 1) / tickSpacing) * tickSpacing - 1
        for (let i = firstTick; i < endPos; i += tickSpacing) {
            const x = LABEL_W + (i - startPos) * CHAR_WIDTH
            if (x < LABEL_W) continue  // safety: never draw in label zone
            ctx.fillText(String(i + 1), x, 12)
            ctx.fillRect(x, 16, 1, 6)
        }

        // Draw reference row
        const refY = HEADER_HEIGHT
        ctx.fillStyle = isLight ? '#374151' : '#718096'  // grey-700 for light
        ctx.font = monoFont(12)
        ctx.textAlign = 'left'
        ctx.textBaseline = 'alphabetic'
        ctx.fillText(refTag, 5, refY + 16)

        if (useBlockMode) {
            // Block mode: render continuous colored blocks for features
            let currentStart = startPos
            let firstBase = refSeq[startPos] || ''
            let currentIsGap = firstBase === '-'
            let currentColor = currentIsGap
                ? panelBg
                : getColorAt(refFeatures, startPos, refSeq, refCdsStripeMap)

            for (let i = startPos + 1; i <= endPos; i++) {
                const base = i < endPos ? (refSeq[i] || '') : ''
                const isGap = i < endPos ? base === '-' : false
                const color = i < endPos
                    ? (isGap ? panelBg : getColorAt(refFeatures, i, refSeq, refCdsStripeMap))
                    : null
                if (isGap !== currentIsGap || color !== currentColor || i === endPos) {
                    // Draw block from currentStart to i-1
                    const x1 = 40 + (currentStart - startPos) * CHAR_WIDTH
                    const x2 = 40 + (i - startPos) * CHAR_WIDTH
                    ctx.fillStyle = currentColor
                    ctx.fillRect(x1, refY + 2, x2 - x1, ROW_HEIGHT - 4)
                    if (currentIsGap) {
                        ctx.fillStyle = GAP_COLOR
                        ctx.fillRect(x1, refY + Math.floor(ROW_HEIGHT / 2) - 1, x2 - x1, 2)
                    }
                    currentStart = i
                    currentIsGap = isGap
                    currentColor = color
                }
            }
        } else {
            // Character mode: render individual bases
            ctx.save()
            ctx.textAlign = 'center'
            ctx.textBaseline = 'middle'
            ctx.font = monoFont(12)
            for (let i = startPos; i < endPos; i++) {
                const x = 40 + (i - startPos) * CHAR_WIDTH
                const base = refSeq[i] || ''

                // Background color based on feature
                const isGap = base === '-'
                const bgColor = isGap
                    ? panelBg
                    : getColorAt(refFeatures, i, refSeq, refCdsStripeMap)
                ctx.fillStyle = bgColor
                ctx.fillRect(x, refY + 2, CHAR_WIDTH, ROW_HEIGHT - 4)

                // Draw base text with luminance-aware contrast so pale UTR colors stay readable.
                const isDarkBg = hexLuminance(bgColor) < 0.46
                if (isGap) {
                    ctx.fillStyle = GAP_COLOR
                } else {
                    ctx.fillStyle = isLight ? (isDarkBg ? '#e2e8f0' : '#1f2937') : '#e2e8f0'
                    if (!isLight && !isDarkBg) ctx.fillStyle = '#1f2937'
                }
                ctx.fillText(base, x + CHAR_WIDTH / 2, refY + ROW_HEIGHT / 2)
            }
            ctx.restore()
        }

        // Draw match row
        const matchY = refY + ROW_HEIGHT

        // Colorblind-friendly palette
        const MATCH_COLOR = '#3b82f6'    // Blue for matches
        const MISMATCH_COLOR = '#ef4444'  // Red for mismatches

        if (useBlockMode) {
            // Block mode: render conservation as colored bands
            // Aggregate matches/mismatches over small windows
            const windowSize = Math.max(1, Math.floor(1 / zoomLevel))
            for (let i = startPos; i < endPos; i += windowSize) {
                const x = 40 + (i - startPos) * CHAR_WIDTH
                const blockWidth = Math.max(1, windowSize * CHAR_WIDTH)

                // Calculate match ratio in this window
                let matches = 0, mismatches = 0, gaps = 0
                for (let j = i; j < Math.min(i + windowSize, endPos); j++) {
                    const refBase = refSeq[j] || ''
                    const tgtBase = tgtSeq[j] || ''
                    if (refBase === tgtBase && refBase !== '-') {
                        matches++
                    } else if (refBase === '-' || tgtBase === '-') {
                        gaps++
                    } else {
                        mismatches++
                    }
                }

                // Color based on conservation ratio — smooth interpolation
                // matchRatio 1.0 = pure blue, 0.0 = pure red, with amber in between
                const total = matches + mismatches + gaps
                const matchRatio = total > 0 ? matches / total : 0

                let color
                if (matchRatio >= 0.95) {
                    // Nearly perfect — solid blue
                    color = '#3b82f6'
                } else if (matchRatio >= 0.8) {
                    // Good conservation — blue tinted slightly toward cyan
                    // Interpolate: 0.95→blue, 0.8→light blue
                    const t = (matchRatio - 0.8) / 0.15
                    const r = Math.round(59 + (1 - t) * 30)
                    const g = Math.round(130 + (1 - t) * 40)
                    const b = Math.round(246 - (1 - t) * 20)
                    color = `rgb(${r},${g},${b})`
                } else if (matchRatio >= 0.5) {
                    // Moderate conservation — transition from amber to orange
                    const t = (matchRatio - 0.5) / 0.3
                    const r = Math.round(239 - t * 60)
                    const g = Math.round(130 + t * 40)
                    const b = Math.round(68 + t * 80)
                    color = `rgb(${r},${g},${b})`
                } else {
                    // Poor conservation — red to dark red
                    const t = matchRatio / 0.5
                    const r = Math.round(200 + t * 39)
                    const g = Math.round(50 + t * 18)
                    const b = Math.round(50 + t * 18)
                    color = `rgb(${r},${g},${b})`
                }

                ctx.fillStyle = color
                ctx.fillRect(x, matchY + 4, blockWidth, ROW_HEIGHT - 8)
            }
        } else {
            // Character mode - render symbols
            ctx.save()
            ctx.textAlign = 'center'
            ctx.textBaseline = 'middle'
            ctx.font = monoFont(12)
            for (let i = startPos; i < endPos; i++) {
                const x = 40 + (i - startPos) * CHAR_WIDTH
                const refBase = refSeq[i] || ''
                const tgtBase = tgtSeq[i] || ''

                let symbol = ' '
                let color = '#2d3748'

                if (refBase === tgtBase && refBase !== '-') {
                    symbol = '|'
                    color = MATCH_COLOR  // Blue for match
                } else if (refBase === '-' || tgtBase === '-') {
                    symbol = '−'  // En dash for gap
                    color = GAP_COLOR  // Red for gap
                } else {
                    symbol = '×'  // Multiplication sign for mismatch
                    color = MISMATCH_COLOR  // Red for mismatch
                }

                ctx.fillStyle = color
                ctx.fillText(symbol, x + CHAR_WIDTH / 2, matchY + ROW_HEIGHT / 2)
            }
            ctx.restore()
        }

        // Draw target row
        const tgtY = matchY + ROW_HEIGHT
        ctx.fillStyle = isLight ? '#374151' : '#718096'
        ctx.textAlign = 'left'
        ctx.textBaseline = 'alphabetic'
        ctx.fillText(tgtTag, 5, tgtY + 16)

        if (useBlockMode) {
            // Block mode: render continuous colored blocks for features
            let currentStart = startPos
            let firstBase = tgtSeq[startPos] || ''
            let currentIsGap = firstBase === '-'
            let currentColor = currentIsGap
                ? panelBg
                : getColorAt(tgtFeatures, startPos, tgtSeq, tgtCdsStripeMap)

            for (let i = startPos + 1; i <= endPos; i++) {
                const base = i < endPos ? (tgtSeq[i] || '') : ''
                const isGap = i < endPos ? base === '-' : false
                const color = i < endPos
                    ? (isGap ? panelBg : getColorAt(tgtFeatures, i, tgtSeq, tgtCdsStripeMap))
                    : null
                if (isGap !== currentIsGap || color !== currentColor || i === endPos) {
                    // Draw block from currentStart to i-1
                    const x1 = 40 + (currentStart - startPos) * CHAR_WIDTH
                    const x2 = 40 + (i - startPos) * CHAR_WIDTH
                    ctx.fillStyle = currentColor
                    ctx.fillRect(x1, tgtY + 2, x2 - x1, ROW_HEIGHT - 4)
                    if (currentIsGap) {
                        ctx.fillStyle = GAP_COLOR
                        ctx.fillRect(x1, tgtY + Math.floor(ROW_HEIGHT / 2) - 1, x2 - x1, 2)
                    }
                    currentStart = i
                    currentIsGap = isGap
                    currentColor = color
                }
            }
        } else {
            // Character mode
            ctx.save()
            ctx.textAlign = 'center'
            ctx.textBaseline = 'middle'
            ctx.font = monoFont(12)
            for (let i = startPos; i < endPos; i++) {
                const x = 40 + (i - startPos) * CHAR_WIDTH
                const base = tgtSeq[i] || ''

                // Background color based on feature
                const isGap = base === '-'
                const bgColor = isGap
                    ? panelBg
                    : getColorAt(tgtFeatures, i, tgtSeq, tgtCdsStripeMap)
                ctx.fillStyle = bgColor
                ctx.fillRect(x, tgtY + 2, CHAR_WIDTH, ROW_HEIGHT - 4)

                // Draw base text with luminance-aware contrast so pale UTR colors stay readable.
                const isDarkBg = hexLuminance(bgColor) < 0.46
                if (isGap) {
                    ctx.fillStyle = GAP_COLOR
                } else {
                    ctx.fillStyle = isLight ? (isDarkBg ? '#e2e8f0' : '#1f2937') : '#e2e8f0'
                    if (!isLight && !isDarkBg) ctx.fillStyle = '#1f2937'
                }
                ctx.fillText(base, x + CHAR_WIDTH / 2, tgtY + ROW_HEIGHT / 2)
            }
            ctx.restore()
        }

        // Boundary lines removed per user request

        // Draw gap markers for collapsed intron regions
        if (gapMarkers && gapMarkers.length > 0) {
            for (const gap of gapMarkers) {
                if (gap.position >= startPos && gap.position < endPos) {
                    const x = 40 + (gap.position - startPos) * CHAR_WIDTH

                    // Draw zigzag break indicator
                    ctx.strokeStyle = '#f59e0b'  // Amber color
                    ctx.lineWidth = 2
                    ctx.setLineDash([])

                    // Draw vertical zigzag
                    ctx.beginPath()
                    ctx.moveTo(x, refY)
                    ctx.lineTo(x + 3, refY + 8)
                    ctx.lineTo(x - 3, refY + 16)
                    ctx.lineTo(x, refY + 24)
                    ctx.lineTo(x + 3, matchY + 8)
                    ctx.lineTo(x - 3, matchY + 16)
                    ctx.lineTo(x, matchY + 24)
                    ctx.lineTo(x + 3, tgtY + 8)
                    ctx.lineTo(x - 3, tgtY + 16)
                    ctx.lineTo(x, tgtY + 20)
                    ctx.stroke()

                    // Draw count label
                    ctx.fillStyle = '#f59e0b'
                    ctx.font = '9px sans-serif'
                    const label = `${gap.count}bp`
                    ctx.fillText(label, x - 8, HEADER_HEIGHT - 5)
                }
            }
        }

    }, [refSeq, tgtSeq, refFeatures, tgtFeatures, refCdsStripeMap, tgtCdsStripeMap, scrollX, viewWidth, gapMarkers, zoomLevel, CHAR_WIDTH, theme])

    // Physics constants - logarithmic-style deceleration
    const BASE_FRICTION = 0.97  // Initial friction (high velocity)
    const END_FRICTION = 0.85   // Final friction (low velocity) - stronger brake
    const MIN_VELOCITY = 0.3    // Stop threshold
    const OVERSCROLL_RESISTANCE = 0.3  // Edge resistance during drag
    const BOUNCE_SPRING = 0.2   // Bounce spring-back rate
    const VELOCITY_SCALE = 5.0  // Amplify gesture velocity

    // Use refs to avoid stale closures in event handlers
    const scrollXRef = useRef(scrollX)
    scrollXRef.current = scrollX
    const zoomLevelRef = useRef(zoomLevel)
    zoomLevelRef.current = zoomLevel

    // Animation loop with log-curve deceleration - friction increases as velocity decreases
    const startMomentumAnimation = useCallback(() => {
        if (animationRef.current) cancelAnimationFrame(animationRef.current)

        let animScrollX = scrollXRef.current
        let animVelocity = velocityRef.current
        const initialVelocity = Math.abs(animVelocity)

        // Reset velocity ref to prevent re-triggering with old values
        velocityRef.current = 0

        const animate = () => {
            const currentMaxScroll = Math.max(0, visibleLength * CHAR_WIDTH - viewWidth + 50)

            // Apply velocity
            animScrollX += animVelocity

            // Logarithmic friction: friction increases as velocity ratio decreases
            // When velocity is high: use BASE_FRICTION (less friction)
            // When velocity is low: use END_FRICTION (more friction)
            const velocityRatio = Math.min(1, Math.abs(animVelocity) / Math.max(initialVelocity, 1))
            const dynamicFriction = END_FRICTION + (BASE_FRICTION - END_FRICTION) * velocityRatio

            // Boundary handling with rubber-band bounce
            if (animScrollX < 0) {
                // Bounce back from left edge
                animVelocity = 0
                animScrollX = animScrollX * (1 - BOUNCE_SPRING)
                if (animScrollX > -0.5) animScrollX = 0
            } else if (animScrollX > currentMaxScroll) {
                // Bounce back from right edge  
                animVelocity = 0
                const overshoot = animScrollX - currentMaxScroll
                animScrollX = currentMaxScroll + overshoot * (1 - BOUNCE_SPRING)
                if (animScrollX < currentMaxScroll + 0.5) animScrollX = currentMaxScroll
            } else {
                // Apply dynamic friction (only when in bounds)
                animVelocity *= dynamicFriction
            }

            // Update React state
            setScrollX(animScrollX)

            // Continue if moving or bouncing back
            const stillMoving = Math.abs(animVelocity) > MIN_VELOCITY
            const stillBouncing = animScrollX < 0 || animScrollX > currentMaxScroll

            if (stillMoving || stillBouncing) {
                animationRef.current = requestAnimationFrame(animate)
            } else {
                // Final snap to bounds
                setScrollX(Math.max(0, Math.min(animScrollX, currentMaxScroll)))
                animationRef.current = null
            }
        }

        if (Math.abs(animVelocity) > MIN_VELOCITY) {
            animationRef.current = requestAnimationFrame(animate)
        }
    }, [visibleLength, viewWidth])

    // Mouse handlers for panning with momentum
    const handleMouseDown = (e) => {
        // Take focus so the panel's own keyboard handler receives keys.
        // preventScroll matters: without it, focusing jumps the page.
        containerRef.current?.focus({ preventScroll: true })

        // Cancel any ongoing animation
        if (animationRef.current) {
            cancelAnimationFrame(animationRef.current)
            animationRef.current = null
        }

        setIsDragging(true)
        setDragStart(e.clientX + scrollX)
        lastPosRef.current = e.clientX
        lastTimeRef.current = performance.now()
        velocityRef.current = 0
    }

    const handleMouseMove = (e) => {
        if (!isDragging) return

        const currentMaxScroll = Math.max(0, visibleLength * CHAR_WIDTH - viewWidth + 50)
        let newScroll = dragStart - e.clientX

        // Apply resistance when over-scrolling
        if (newScroll < 0) {
            newScroll = newScroll * OVERSCROLL_RESISTANCE
        } else if (newScroll > currentMaxScroll) {
            const overshoot = newScroll - currentMaxScroll
            newScroll = currentMaxScroll + overshoot * OVERSCROLL_RESISTANCE
        }

        // Track velocity - simple and predictable
        const now = performance.now()
        const dt = now - lastTimeRef.current
        if (dt > 0 && dt < 100) {  // Ignore stale timestamps
            const dx = lastPosRef.current - e.clientX
            // Scale velocity: faster drag = faster fling
            velocityRef.current = (dx / dt) * 16 * VELOCITY_SCALE
        }
        lastPosRef.current = e.clientX
        lastTimeRef.current = now

        setScrollX(newScroll)
    }

    const handleMouseUp = () => {
        if (!isDragging) return  // Don't trigger momentum if we weren't dragging
        setIsDragging(false)
        // Start momentum animation
        startMomentumAnimation()
    }

    // Wheel handler - processes BOTH axes simultaneously:
    //   deltaX → horizontal pan
    //   deltaY → zoom in/out
    // This avoids fragile gesture classification and works naturally with trackpads.
    useEffect(() => {
        const container = containerRef.current
        if (!container) return

        let wheelTimeout = null

        const handleWheel = (e) => {
            e.preventDefault()
            e.stopPropagation()

            // Cancel any ongoing momentum animation
            if (animationRef.current) {
                cancelAnimationFrame(animationRef.current)
                animationRef.current = null
            }

            // Reset velocity at the start of each event to prevent stale drift
            velocityRef.current = 0

            // Read current values from refs to avoid stale closures
            let currentZoom = zoomLevelRef.current
            let currentScrollX = scrollXRef.current

            // Normalised deltas: Firefox and some Linux mice report deltaMode 1
            // (lines) with values around 3 rather than pixels around 100, which
            // made this panel ~30x less responsive on those setups.
            const { dx, dy } = normalizeWheelDelta(e, { pageHeight: window.innerHeight })

            // Gesture separation: prioritize dominant axis
            // If Ctrl key is pressed, it's a pinch zoom (browser convention) => Force Zoom
            // Otherwise, compare deltaX vs deltaY to decide Pan vs Zoom
            const isPinch = e.ctrlKey
            const isVertical = Math.abs(dy) > Math.abs(dx)
            const isHorizontal = Math.abs(dx) > Math.abs(dy)

            // --- ZOOM: Apply if Pinch OR (Vertical dominant AND significant) ---
            if (isPinch || (isVertical && Math.abs(dy) > 0.5)) {
                const currentCharWidth = BASE_CHAR_WIDTH * currentZoom

                // Calculate zoom centered on cursor position
                const rect = container.getBoundingClientRect()
                const cursorX = e.clientX - rect.left
                const charIndexUnderCursor = (currentScrollX + cursorX) / currentCharWidth

                // Sensitivity: pinch gestures (ctrlKey) use coarser deltas
                const sensitivity = e.ctrlKey ? 0.01 : 0.005

                // Apply zoom (negative deltaY = zoom in, positive = zoom out).
                //
                // Divided, not multiplied: zoomLevel is a magnification, i.e.
                // the reciprocal of the genomic span the other views zoom on,
                // so the shared factor has to be inverted here.
                //
                // The old `1 - deltaY * sensitivity` went NEGATIVE for a real
                // mouse wheel — Chromium sends deltaY ≈ ±120 per notch, so at
                // the ctrl sensitivity of 0.01 one notch gave -0.2, and the
                // resulting negative zoom was silently absorbed by the MIN_ZOOM
                // clamp. One ctrl+wheel notch jumped straight to minimum zoom.
                const zoomFactor = wheelZoomFactor(dy, sensitivity)
                const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, currentZoom / zoomFactor))
                const newCharWidth = BASE_CHAR_WIDTH * newZoom

                // Adjust scroll to keep cursor position stable
                currentScrollX = Math.max(0, charIndexUnderCursor * newCharWidth - cursorX)
                currentZoom = newZoom
            }

            // --- PAN: Apply only if NOT Pinch AND Horizontal dominant AND significant ---
            else if (!isPinch && isHorizontal && Math.abs(dx) > 0.5) {
                const currentCharWidth = BASE_CHAR_WIDTH * currentZoom
                const currentMaxScroll = Math.max(0, visibleLength * currentCharWidth - viewWidth + 50)

                let newScroll = currentScrollX + dx

                // Apply resistance at edges
                if (newScroll < 0) {
                    newScroll = newScroll * 0.3
                } else if (newScroll > currentMaxScroll) {
                    const overshoot = newScroll - currentMaxScroll
                    newScroll = currentMaxScroll + overshoot * 0.3
                }

                currentScrollX = newScroll

                // Set velocity for momentum (only when actually panning)
                velocityRef.current = dx * VELOCITY_SCALE
            }

            // Update refs immediately for next rapid event
            zoomLevelRef.current = currentZoom
            scrollXRef.current = currentScrollX

            // Commit state updates
            setZoomLevel(currentZoom)
            setScrollX(currentScrollX)
            // Note: No momentum animation for wheel events.
            // macOS trackpads already send decelerating events (built-in inertia).
        }

        // Add with { passive: false } to allow preventDefault
        container.addEventListener('wheel', handleWheel, { passive: false })
        return () => {
            container.removeEventListener('wheel', handleWheel)
            clearTimeout(wheelTimeout)
        }
    }, [visibleLength, viewWidth, startMomentumAnimation])

    // Keyboard controls: arrow keys for scroll/zoom.
    //
    // Bound to the panel element, NOT to window. As a window listener this fired
    // while the panel was scrolled off-screen, while another view was mounted,
    // and while a modal was open — arrow keys anywhere in the app silently moved
    // an alignment the user could not see. Element scoping removes that whole
    // class of bug rather than patching around it with focus guards.
    useEffect(() => {
        const container = containerRef.current
        if (!container) return undefined

        const handleKeyDown = (e) => {
            // Never shadow a text field or an OS/app shortcut.
            if (isTextEntryTarget(e.target)) return
            if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return

            const scrollStep = viewWidth * 0.5  // Scroll by half viewport width
            const currentMaxScroll = Math.max(0, visibleLength * CHAR_WIDTH - viewWidth + 50)

            switch (e.key) {
                case 'ArrowLeft':
                    e.preventDefault()
                    setScrollX(prev => Math.max(0, prev - scrollStep))
                    break
                case 'ArrowRight':
                    e.preventDefault()
                    setScrollX(prev => Math.min(currentMaxScroll, prev + scrollStep))
                    break
                case 'ArrowUp':
                    e.preventDefault()
                    {
                        // Zoom in, centered on current view center
                        // Use refs to get current values, not stale closure values
                        const currentScrollX = scrollXRef.current
                        const currentCharWidth = BASE_CHAR_WIDTH * zoomLevel
                        const centerChar = (currentScrollX + viewWidth / 2) / currentCharWidth

                        const newZoom = Math.min(MAX_ZOOM, zoomLevel * 1.3)
                        const newCharWidth = BASE_CHAR_WIDTH * newZoom
                        const newScrollX = Math.max(0, centerChar * newCharWidth - viewWidth / 2)

                        // Update both atomically (in same render)
                        setZoomLevel(newZoom)
                        setScrollX(newScrollX)
                    }
                    break
                case 'ArrowDown':
                    e.preventDefault()
                    {
                        // Zoom out, centered on current view center
                        // Use refs to get current values, not stale closure values
                        const currentScrollX = scrollXRef.current
                        const currentCharWidth = BASE_CHAR_WIDTH * zoomLevel
                        const centerChar = (currentScrollX + viewWidth / 2) / currentCharWidth

                        const newZoom = Math.max(MIN_ZOOM, zoomLevel / 1.3)
                        const newCharWidth = BASE_CHAR_WIDTH * newZoom
                        const newScrollX = Math.max(0, centerChar * newCharWidth - viewWidth / 2)

                        // Update both atomically (in same render)
                        setZoomLevel(newZoom)
                        setScrollX(newScrollX)
                    }
                    break
            }
        }

        container.addEventListener('keydown', handleKeyDown)
        return () => container.removeEventListener('keydown', handleKeyDown)
    }, [viewWidth, visibleLength, CHAR_WIDTH, zoomLevel])

    // Stats display
    const stats = alignment ? {
        identity: alignment.identity.toFixed(2),
        gaps: alignment.gaps,
        length: alignment.alignment_length,
        refCoords: `${alignment.reference.chrom}:${alignment.reference.genomic_start}-${alignment.reference.genomic_end}`,
        tgtCoords: `${alignment.target.chrom}:${alignment.target.genomic_start}-${alignment.target.genomic_end}`
    } : null

    const isLight = theme === 'light'
    const refTranscriptId = activeRefId || alignment.transcript_id.replace('transcript:', '')
    const tgtTranscriptId = activeTargetId || alignment.target_transcript_id?.replace('transcript:', '') || tgtTag
    const containerClass = isLight
        ? 'bg-white border border-gray-200 shadow-sm'
        : 'bg-gray-800'

    return (
        <div className={`${containerClass} rounded-lg overflow-hidden flex flex-col`}>
            {/* Stats header */}
            <div className={`${isLight ? 'bg-gray-100 border-gray-200' : 'bg-gray-850 border-gray-700'} border-b px-4 py-3`}>
                <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0 flex-shrink">
                        {/* G1 Row */}
                        <div className={`text-sm flex flex-wrap items-baseline gap-x-3 ${isLight ? 'text-gray-900' : 'text-white'}`}>
                            <span className="font-semibold whitespace-nowrap">{refTranscriptId}</span>
                            <span className={`text-xs font-mono whitespace-nowrap ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                {stats?.refCoords} ({alignment.reference.strand})
                            </span>
                        </div>
                        {/* G2 Row */}
                        <div className={`text-sm flex flex-wrap items-baseline gap-x-3 mt-1 ${isLight ? 'text-gray-700' : 'text-gray-300'}`}>
                            <span className="font-semibold whitespace-nowrap">{tgtTranscriptId}</span>
                            <span className={`text-xs font-mono whitespace-nowrap ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                {stats?.tgtCoords} ({alignment.target.strand})
                            </span>
                        </div>
                    </div>
                    <div className="flex items-center gap-4 text-sm shrink-0">
                        <div className="text-center">
                            <div className={`text-lg font-bold ${alignment.identity >= 95 ? 'text-green-500' :
                                alignment.identity >= 80 ? 'text-yellow-500' :
                                    'text-red-500'
                                }`}>
                                {stats?.identity}%
                            </div>
                            <div className={`text-xs ${isLight ? 'text-gray-500' : 'text-gray-500'}`}>Identity</div>
                        </div>
                        <div className="text-center">
                            <div className={`text-lg font-bold ${isLight ? 'text-gray-700' : 'text-gray-300'}`}>{stats?.gaps}</div>
                            <div className={`text-xs ${isLight ? 'text-gray-500' : 'text-gray-500'}`}>Gaps</div>
                        </div>
                        <div className="text-center">
                            <div className={`text-lg font-bold ${isLight ? 'text-gray-700' : 'text-gray-300'}`}>{stats?.length}</div>
                            <div className={`text-xs ${isLight ? 'text-gray-500' : 'text-gray-500'}`}>Length</div>
                        </div>
                        <div className={`flex items-center gap-3 border-l ${isLight ? 'border-gray-300' : 'border-gray-600'} pl-4`}>
                            {/* Zoom to 100% button */}
                            <button
                                className={`px-2 py-1 text-xs rounded transition-colors ${isLight ? 'bg-gray-200 hover:bg-gray-300 text-gray-700' : 'bg-gray-700 hover:bg-gray-600 text-gray-200'}`}
                                onClick={() => {
                                    // Zoom to 100%, centered on current view
                                    const centerChar = (scrollX + viewWidth / 2) / CHAR_WIDTH
                                    const newCharWidth = BASE_CHAR_WIDTH * MAX_ZOOM
                                    setZoomLevel(MAX_ZOOM)
                                    setScrollX(Math.max(0, centerChar * newCharWidth - viewWidth / 2))
                                }}
                                title="Zoom to sequence view"
                            >
                                <svg className="w-6 h-6" viewBox="0 0 24 24">
                                    {/* Magnifying glass with rim, A in center, and small diagonal handle */}
                                    <circle cx="10" cy="10" r="8" fill="none" stroke={isLight ? '#0099ff' : '#3b82f6'} strokeWidth="2.5" />
                                    <line x1="16" y1="16" x2="22" y2="22" stroke={isLight ? '#0099ff' : '#3b82f6'} strokeWidth="2.5" strokeLinecap="round" />
                                    <text x="10" y="14" textAnchor="middle" fontSize="10" fontWeight="bold" fill={isLight ? '#0099ff' : '#3b82f6'}>A</text>
                                </svg>
                            </button>

                            {/* Zoom slider */}
                            <input
                                type="range"
                                min={MIN_ZOOM * 100}
                                max={MAX_ZOOM * 100}
                                value={zoomLevel * 100}
                                onChange={(e) => {
                                    const centerChar = (scrollX + viewWidth / 2) / CHAR_WIDTH
                                    const newZoom = parseFloat(e.target.value) / 100
                                    const newCharWidth = BASE_CHAR_WIDTH * newZoom
                                    setZoomLevel(newZoom)
                                    setScrollX(Math.max(0, centerChar * newCharWidth - viewWidth / 2))
                                }}
                                className={`w-20 h-2 rounded-lg cursor-pointer ${isLight ? 'light-slider' : 'dark-slider'}`}
                                title="Drag to adjust zoom"
                            />

                            {/* Zoom percentage */}
                            <div
                                className="text-sm font-medium text-blue-400 cursor-pointer hover:text-blue-300 min-w-[45px] text-center"
                                onClick={() => {
                                    const centerChar = (scrollX + viewWidth / 2) / CHAR_WIDTH
                                    const newCharWidth = BASE_CHAR_WIDTH * MAX_ZOOM
                                    setZoomLevel(MAX_ZOOM)
                                    setScrollX(Math.max(0, centerChar * newCharWidth - viewWidth / 2))
                                }}
                                title="Click to reset to 100%"
                            >
                                {Math.round(zoomLevel * 100)}%
                            </div>
                        </div>
                    </div>
                </div>
            </div>


            {/* Canvas viewport */}
            <div
                ref={containerRef}
                // Focusable so the element-scoped keyboard handler above can
                // receive keys at all. focus-visible only, so mouse users never
                // see a ring.
                tabIndex={0}
                role="group"
                aria-label="Alignment viewer. Left and right arrows scroll, up and down zoom."
                className="p-4 cursor-grab active:cursor-grabbing select-none relative overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseUp}
            >
                <canvas ref={canvasRef} className="rounded" />
            </div>

            {/* Exon overview mini-map - uses collapsed coordinates when introns are collapsed */}
            {/* Structure: Variation track (top 12px) | G1 track (middle 18px) | G2 track (bottom 18px) */}
            <div className="px-4 py-0 mb-1 pl-8">
                <div
                    className={`relative ${isLight ? 'bg-gray-200' : 'bg-gray-750'} rounded cursor-pointer`}
                    style={{ height: '56px' }}
                    onClick={(e) => {
                        // Calculate click position as percentage of minimap width
                        const rect = e.currentTarget.getBoundingClientRect()
                        const clickX = e.clientX - rect.left
                        const clickPercent = clickX / rect.width

                        // Convert to alignment index and center the viewport there
                        const targetIdx = clickPercent * visibleLength
                        const targetScrollX = Math.max(0, targetIdx * CHAR_WIDTH - viewWidth / 2)
                        setScrollX(Math.min(targetScrollX, maxScroll))
                    }}
                >
                    {/* G1 track - positioned in middle section */}
                    <div className="absolute left-0 right-0 h-5" style={{ top: '14px' }}>
                        <span className="absolute -left-1 top-0 text-xs text-gray-500" style={{ transform: 'translateX(-100%)', paddingRight: '4px' }}>{refTag}</span>
                        <svg className="w-full h-full" preserveAspectRatio="none">
                            {/* Intron lines (backbone) - only show if NOT collapsed */}
                            {!collapseIntrons && refFeatures.filter(f => f.type === 'exon').length > 0 && (
                                <line
                                    x1={`${(refFeatures.filter(f => f.type === 'exon')[0]?.start / visibleLength) * 100}%`}
                                    y1="50%"
                                    x2={`${(refFeatures.filter(f => f.type === 'exon').slice(-1)[0]?.end / visibleLength) * 100}%`}
                                    y2="50%"
                                    stroke="#4a5568"
                                    strokeWidth="2"
                                />
                            )}
                            {/* Exon blocks - clickable with hover effect */}
                            {refFeatures.filter(f => f.type === 'exon').map((exon, idx) => (
                                <rect
                                    key={`ref-exon-${idx}`}
                                    x={`${(exon.start / visibleLength) * 100}%`}
                                    y="10%"
                                    width={`${((exon.end - exon.start + 1) / visibleLength) * 100}%`}
                                    height="80%"
                                    fill="#4299e1"
                                    rx="2"
                                    style={{ cursor: 'pointer' }}
                                    className="hover:stroke-white hover:stroke-2"
                                    onClick={(e) => {
                                        e.stopPropagation()
                                        // Smart zoom: 100% if exon fits, otherwise block view threshold
                                        const exonWidth = exon.end - exon.start + 1
                                        const zoomForFullExon = viewWidth / (exonWidth * BASE_CHAR_WIDTH * 1.2)
                                        // If exon fits at 100%, use 100%. Otherwise zoom out to just below block threshold
                                        const targetZoom = zoomForFullExon >= MAX_ZOOM
                                            ? MAX_ZOOM
                                            : Math.min(BLOCK_THRESHOLD * 0.95, zoomForFullExon)
                                        const newCharWidth = BASE_CHAR_WIDTH * targetZoom
                                        const exonCenter = (exon.start + exon.end) / 2
                                        setZoomLevel(targetZoom)
                                        setScrollX(Math.max(0, exonCenter * newCharWidth - viewWidth / 2))
                                    }}
                                />
                            ))}
                        </svg>
                    </div>
                    {/* G2 track - positioned at bottom */}
                    <div className="absolute left-0 right-0 h-5" style={{ top: '36px' }}>
                        <span className="absolute -left-1 top-0 text-xs text-gray-500" style={{ transform: 'translateX(-100%)', paddingRight: '4px' }}>{tgtTag}</span>
                        <svg className="w-full h-full" preserveAspectRatio="none">
                            {/* Intron lines (backbone) - only show if NOT collapsed */}
                            {!collapseIntrons && tgtFeatures.filter(f => f.type === 'exon').length > 0 && (
                                <line
                                    x1={`${(tgtFeatures.filter(f => f.type === 'exon')[0]?.start / visibleLength) * 100}%`}
                                    y1="50%"
                                    x2={`${(tgtFeatures.filter(f => f.type === 'exon').slice(-1)[0]?.end / visibleLength) * 100}%`}
                                    y2="50%"
                                    stroke="#4a5568"
                                    strokeWidth="2"
                                />
                            )}
                            {/* Exon blocks - clickable with hover effect */}
                            {tgtFeatures.filter(f => f.type === 'exon').map((exon, idx) => (
                                <rect
                                    key={`tgt-exon-${idx}`}
                                    x={`${(exon.start / visibleLength) * 100}%`}
                                    y="10%"
                                    width={`${((exon.end - exon.start + 1) / visibleLength) * 100}%`}
                                    height="80%"
                                    fill="#4299e1"
                                    rx="2"
                                    style={{ cursor: 'pointer' }}
                                    className="hover:stroke-white hover:stroke-2"
                                    onClick={(e) => {
                                        e.stopPropagation()
                                        // Smart zoom: 100% if exon fits, otherwise block view threshold
                                        const exonWidth = exon.end - exon.start + 1
                                        const zoomForFullExon = viewWidth / (exonWidth * BASE_CHAR_WIDTH * 1.2)
                                        // If exon fits at 100%, use 100%. Otherwise zoom out to just below block threshold
                                        const targetZoom = zoomForFullExon >= MAX_ZOOM
                                            ? MAX_ZOOM
                                            : Math.min(BLOCK_THRESHOLD * 0.95, zoomForFullExon)
                                        const newCharWidth = BASE_CHAR_WIDTH * targetZoom
                                        const exonCenter = (exon.start + exon.end) / 2
                                        setZoomLevel(targetZoom)
                                        setScrollX(Math.max(0, exonCenter * newCharWidth - viewWidth / 2))
                                    }}
                                />
                            ))}
                        </svg>
                    </div>
                    {/* Variation markers - positioned at top, above transcripts */}
                    <div className="absolute left-0 right-0 h-3" style={{ top: '0px' }}>
                        <svg className="w-full h-full" viewBox="0 0 100 12" preserveAspectRatio="none">
                            {variationMarkers.map((marker, idx) => {
                                if (marker.type === 'triangle') {
                                    // Single triangle pointing down
                                    const xPos = (marker.position / visibleLength) * 100
                                    const triWidth = 0.8  // Width in viewBox units
                                    return (
                                        <polygon
                                            key={`var-tri-${idx}`}
                                            points={`${xPos - triWidth / 2},0 ${xPos + triWidth / 2},0 ${xPos},10`}
                                            fill="#ef4444"
                                            style={{ cursor: 'pointer' }}
                                            className="hover:fill-red-300"
                                            onClick={(e) => {
                                                e.stopPropagation()
                                                // Navigate to position at 100% zoom
                                                const centerChar = marker.position
                                                const newCharWidth = BASE_CHAR_WIDTH * MAX_ZOOM
                                                setZoomLevel(MAX_ZOOM)
                                                setScrollX(Math.max(0, centerChar * newCharWidth - viewWidth / 2))
                                            }}
                                        />
                                    )
                                } else {
                                    // Block for dense variation region
                                    const startPos = (marker.start / visibleLength) * 100
                                    const blockWidth = ((marker.end - marker.start + 1) / visibleLength) * 100
                                    return (
                                        <rect
                                            key={`var-block-${idx}`}
                                            x={startPos}
                                            y={0}
                                            width={Math.max(0.5, blockWidth)}
                                            height={10}
                                            fill="#ef4444"
                                            opacity="0.9"
                                            rx="0.3"
                                            style={{ cursor: 'pointer' }}
                                            className="hover:fill-red-300"
                                            onClick={(e) => {
                                                e.stopPropagation()
                                                // Calculate sub-position within block based on click
                                                const rect = e.currentTarget.ownerSVGElement.getBoundingClientRect()
                                                const clickX = e.clientX - rect.left
                                                const clickPercent = clickX / rect.width
                                                const targetIdx = clickPercent * visibleLength

                                                // Navigate to clicked position within block
                                                const newCharWidth = BASE_CHAR_WIDTH * MAX_ZOOM
                                                setZoomLevel(MAX_ZOOM)
                                                setScrollX(Math.max(0, targetIdx * newCharWidth - viewWidth / 2))
                                            }}
                                        />
                                    )
                                }
                            })}
                        </svg>
                    </div>

                    {/* Viewport indicator - now uses simple scrollX / visibleLength since minimap is in same coord space */}
                    <div
                        className="absolute top-0 bottom-0 bg-white/10 border-l border-r border-blue-400 pointer-events-none"
                        style={{
                            left: `${(scrollX / (visibleLength * CHAR_WIDTH)) * 100}%`,
                            width: `${Math.min(100, (viewWidth / (visibleLength * CHAR_WIDTH)) * 100)}%`
                        }}
                    />
                </div>
            </div>

            {/* Scroll position indicator - fixed thumb size draggable */}
            <div className="px-4 pb-3">
                <div
                    className={`h-3 ${isLight ? 'bg-gray-300' : 'bg-gray-700'} rounded-full overflow-hidden cursor-pointer relative`}
                    onMouseDown={(e) => {
                        const SCROLL_THUMB_WIDTH = 60
                        const rect = e.currentTarget.getBoundingClientRect()
                        const clickX = e.clientX - rect.left
                        const maxScroll = Math.max(0, visibleLength * CHAR_WIDTH - viewWidth + 50)

                        // Calculate new scroll percent accounting for fixed thumb width
                        // percent = (clickX - thumbWidth/2) / (trackWidth - thumbWidth)
                        const trackWidth = rect.width
                        const effectiveTrack = trackWidth - SCROLL_THUMB_WIDTH
                        let clickPercent = (clickX - SCROLL_THUMB_WIDTH / 2) / effectiveTrack
                        clickPercent = Math.max(0, Math.min(1, clickPercent))

                        setScrollX(clickPercent * maxScroll)

                        // Start dragging
                        const handleDrag = (moveEvent) => {
                            const newX = moveEvent.clientX - rect.left
                            let newPercent = (newX - SCROLL_THUMB_WIDTH / 2) / effectiveTrack
                            newPercent = Math.max(0, Math.min(1, newPercent))
                            setScrollX(newPercent * maxScroll)
                        }
                        const handleUp = () => {
                            window.removeEventListener('mousemove', handleDrag)
                            window.removeEventListener('mouseup', handleUp)
                        }
                        window.addEventListener('mousemove', handleDrag)
                        window.addEventListener('mouseup', handleUp)
                    }}
                >
                    <div
                        className="h-full bg-blue-500 rounded-full transition-none hover:bg-blue-400"
                        style={{
                            width: `60px`,
                            marginLeft: (() => {
                                const SCROLL_THUMB_WIDTH = 60
                                // maxScroll represents the maximum scrollX value
                                // Use the maxScroll from outer scope if available, else recompute (safety)
                                const curMaxScroll = Math.max(0, visibleLength * CHAR_WIDTH - viewWidth + 50)
                                if (curMaxScroll <= 0) return '0px'

                                // Calculate percentage of current scroll vs max scroll
                                const scrollPercent = scrollX / curMaxScroll

                                // Map that percentage to the available track width minus the thumb width
                                // We use CSS calculation: calc(percent * (100% - thumbWidth))
                                return `calc(${scrollPercent} * (100% - ${SCROLL_THUMB_WIDTH}px))`
                            })()
                        }}
                    />
                </div>
                <p className="text-xs text-gray-500 mt-1 text-center">
                    Click scrollbar or drag alignment to pan
                </p>
            </div>
        </div >
    )
}

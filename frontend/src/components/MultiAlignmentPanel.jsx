import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FEATURE_COLORS } from './FeatureLegend'

const ROW_HEIGHT = 24
const HEADER_HEIGHT = 34
const LABEL_WIDTH = 44
const MINIMAP_LABEL_WIDTH = 32
const BASE_CHAR_WIDTH = 10
const MIN_ZOOM = 0.02
const MAX_ZOOM = 2.0
const BLOCK_THRESHOLD = 0.3
const INTRON_EDGE_BP = 10
const CDS_STRIPE_COLORS = ['#60a5fa', '#bfdbfe']
const SELECTION_MIN_DRAG_PX = 6

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value))
}

function quantizedWindowSizeByPixels(charWidth, targetPixels = 12, minBp = 1, maxBp = 1024) {
    const safeCharWidth = Math.max(0.1, Number(charWidth) || 0.1)
    const rawBp = Math.max(minBp, targetPixels / safeCharWidth)
    const power = Math.round(Math.log2(rawBp))
    const size = Math.pow(2, power)
    return Math.max(minBp, Math.min(maxBp, Math.max(1, Math.round(size))))
}

function hexLuminance(hexColor) {
    const hex = String(hexColor || '').replace('#', '')
    if (hex.length !== 6) return 0
    const r = parseInt(hex.slice(0, 2), 16) / 255
    const g = parseInt(hex.slice(2, 4), 16) / 255
    const b = parseInt(hex.slice(4, 6), 16) / 255
    return (0.2126 * r) + (0.7152 * g) + (0.0722 * b)
}

function normalizeFeature(feature) {
    if (!feature || !Number.isFinite(Number(feature.start)) || !Number.isFinite(Number(feature.end))) return null
    const start = Math.min(Number(feature.start), Number(feature.end))
    const end = Math.max(Number(feature.start), Number(feature.end))
    return { ...feature, start, end }
}

function normalizeRow(row, index) {
    const features = (Array.isArray(row?.display_features) ? row.display_features : Array.isArray(row?.features) ? row.features : []).map(normalizeFeature).filter(Boolean)
    return {
        genomeKey: String(row?.genome_key || row?.genome || `row_${index + 1}`),
        tag: String(row?.tag || `G${index + 1}`),
        geneLabel: String(row?.gene_label || row?.geneLabel || ''),
        transcriptId: String(row?.transcript_id || ''),
        selectedTranscriptCoordLabel: String(row?.selected_transcript_coord_label || row?.selectedTranscriptCoordLabel || ''),
        chrom: String(row?.chrom || ''),
        strand: String(row?.strand || '+'),
        genomicStart: Number(row?.genomic_start || 0),
        genomicEnd: Number(row?.genomic_end || 0),
        identityToConsensus: Number(row?.identity_to_consensus || 0),
        sequence: String(row?.aligned_sequence || ''),
        boundaryStatus: String(row?.boundary_status || row?.boundaryStatus || ''),
        boundaryMessage: String(row?.boundary_message || row?.boundaryMessage || ''),
        coverageStatus: String(row?.coverage_status || row?.coverageStatus || 'full'),
        notAlignedBpLeft: Math.max(0, Number(row?.not_aligned_bp_left ?? row?.notAlignedBpLeft) || 0),
        notAlignedBpRight: Math.max(0, Number(row?.not_aligned_bp_right ?? row?.notAlignedBpRight) || 0),
        coveredColumnStart: Number.isFinite(Number(row?.covered_column_start ?? row?.coveredColumnStart))
            ? Number(row?.covered_column_start ?? row?.coveredColumnStart)
            : null,
        coveredColumnEnd: Number.isFinite(Number(row?.covered_column_end ?? row?.coveredColumnEnd))
            ? Number(row?.covered_column_end ?? row?.coveredColumnEnd)
            : null,
        noCoverage: Boolean(row?.no_coverage ?? row?.noCoverage),
        features,
    }
}

function buildCdsStripeMap(features, seq) {
    const cdsRanges = (features || [])
        .filter((f) => f?.type === 'cds')
        .map((f) => ({ start: f.start, end: f.end }))
        .sort((a, b) => a.start - b.start || a.end - b.end)
    if (cdsRanges.length === 0) return null

    const startCodons = (features || [])
        .filter((f) => f?.type === 'start_codon')
        .map((f) => ({ start: f.start, end: f.end }))
        .sort((a, b) => a.start - b.start || a.end - b.end)

    let anchor = null
    for (const sc of startCodons) {
        const codon = String(seq.substring(sc.start, sc.end + 1) || '').toUpperCase()
        if (codon !== 'ATG') continue
        const inside = cdsRanges.some((r) => sc.start >= r.start && sc.end <= r.end)
        if (inside) {
            anchor = sc.start
            break
        }
    }
    if (anchor === null) anchor = cdsRanges[0].start

    const stripeMap = new Map()
    let cdsBaseIndex = 0
    let started = false
    for (const range of cdsRanges) {
        for (let pos = range.start; pos <= range.end; pos += 1) {
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
}

function getColorAt(features, pos, seq, cdsStripeMap = null) {
    for (let i = (features?.length || 0) - 1; i >= 0; i -= 1) {
        const f = features[i]
        if (pos < f.start || pos > f.end) continue

        if (f.type === 'stop_codon' && seq) {
            const codon = seq.substring(f.start, f.end + 1).toUpperCase()
            if (!['TAA', 'TAG', 'TGA'].includes(codon)) continue
        }

        if (f.type === 'cds' && cdsStripeMap?.has(pos)) return cdsStripeMap.get(pos)

        const colorDef = FEATURE_COLORS[f.type]
        if (colorDef?.bg) return colorDef.bg
    }
    return '#2d3748'
}

function buildCollapsedRows(rows, alignmentLength, sourceGenomeKey, collapseIntrons) {
    const baseLength = Math.max(0, Number(alignmentLength || 0))
    if (!collapseIntrons || baseLength === 0 || !Array.isArray(rows) || rows.length === 0) {
        return {
            rows,
            visibleLength: baseLength,
            positionMap: null,
            gapMarkers: [],
        }
    }

    const source = rows.find((row) => row.genomeKey === sourceGenomeKey) || rows[0]
    const intronRanges = (source?.features || [])
        .filter((f) => f.type === 'intron')
        .map((f) => ({ start: Math.max(0, f.start), end: Math.min(baseLength - 1, f.end) }))
        .filter((f) => f.start <= f.end)

    if (intronRanges.length === 0) {
        return {
            rows,
            visibleLength: baseLength,
            positionMap: null,
            gapMarkers: [],
        }
    }

    const keepMask = new Uint8Array(baseLength)
    keepMask.fill(1)
    const collapsedRanges = []

    for (const intron of intronRanges) {
        const intronLen = intron.end - intron.start + 1
        if (intronLen <= INTRON_EDGE_BP * 2) continue
        const collapseStart = intron.start + INTRON_EDGE_BP
        const collapseEnd = intron.end - INTRON_EDGE_BP
        if (collapseEnd < collapseStart) continue
        for (let pos = collapseStart; pos <= collapseEnd; pos += 1) {
            keepMask[pos] = 0
        }
        collapsedRanges.push({
            collapseStart,
            collapseEnd,
            afterOldPos: collapseStart - 1,
            collapsedCount: collapseEnd - collapseStart + 1,
        })
    }

    const oldToNew = new Map()
    let newPos = 0
    for (let oldPos = 0; oldPos < baseLength; oldPos += 1) {
        if (!keepMask[oldPos]) continue
        oldToNew.set(oldPos, newPos)
        newPos += 1
    }

    if (newPos === 0) {
        return {
            rows,
            visibleLength: baseLength,
            positionMap: null,
            gapMarkers: [],
        }
    }

    const remapFeatures = (features) => {
        return (features || []).map((f) => {
            let newStart = null
            let newEnd = null
            for (let pos = f.start; pos <= f.end; pos += 1) {
                const mapped = oldToNew.get(pos)
                if (mapped == null) continue
                if (newStart == null) newStart = mapped
                newEnd = mapped
            }
            if (newStart == null || newEnd == null) return null
            return { ...f, start: newStart, end: newEnd }
        }).filter(Boolean)
    }

    const collapsedRows = rows.map((row) => {
        const chars = []
        for (let oldPos = 0; oldPos < baseLength; oldPos += 1) {
            if (!keepMask[oldPos]) continue
            chars.push(row.sequence?.[oldPos] || '')
        }
        return {
            ...row,
            sequence: chars.join(''),
            features: remapFeatures(row.features),
        }
    })

    const gapMarkers = []
    for (const marker of collapsedRanges) {
        const mapped = oldToNew.get(marker.afterOldPos)
        if (mapped == null) continue
        gapMarkers.push({
            position: mapped + 1,
            count: marker.collapsedCount,
        })
    }

    return {
        rows: collapsedRows,
        visibleLength: newPos,
        positionMap: oldToNew,
        gapMarkers,
    }
}

function buildConsensusSequence(rows, alignmentLength, providedConsensus = '') {
    if (providedConsensus && providedConsensus.length === alignmentLength) return providedConsensus
    const len = Math.max(0, Number(alignmentLength || 0))
    if (len === 0) return ''

    const out = new Array(len)
    for (let i = 0; i < len; i += 1) {
        const counts = new Map()
        for (const row of rows || []) {
            const ch = String(row.sequence?.[i] || '-').toUpperCase()
            if (ch === '-') continue
            counts.set(ch, (counts.get(ch) || 0) + 1)
        }
        if (counts.size === 0) {
            out[i] = '-'
            continue
        }
        let bestChar = '-'
        let bestCount = -1
        for (const [ch, count] of counts.entries()) {
            if (count > bestCount) {
                bestChar = ch
                bestCount = count
            }
        }
        out[i] = bestChar
    }
    return out.join('')
}

function calculateVariationMarkers(rows, consensus, visibleLength) {
    if (!rows.length || !consensus || visibleLength <= 0) return []

    const WINDOW_SIZE = 100
    const DENSE_THRESHOLD = 5
    const windowCounts = new Map()

    for (let i = 0; i < visibleLength; i += 1) {
        const cons = consensus[i] || '-'
        let diffCount = 0
        for (const row of rows) {
            const ch = row.sequence?.[i] || '-'
            if (ch === cons && ch !== '-') continue
            if (ch === '-' && cons === '-') continue
            diffCount += 1
        }
        if (diffCount <= 0) continue

        const windowStart = Math.floor(i / WINDOW_SIZE) * WINDOW_SIZE
        if (!windowCounts.has(windowStart)) {
            windowCounts.set(windowStart, { count: 0, positions: [] })
        }
        const bucket = windowCounts.get(windowStart)
        bucket.count += 1
        bucket.positions.push(i)
    }

    const markers = []
    for (const [, data] of windowCounts.entries()) {
        if (data.count > DENSE_THRESHOLD) {
            markers.push({
                type: 'block',
                start: data.positions[0],
                end: data.positions[data.positions.length - 1],
                count: data.count,
            })
        } else {
            for (const pos of data.positions) {
                markers.push({ type: 'triangle', position: pos })
            }
        }
    }
    return markers
}

export default function MultiAlignmentPanel({
    result,
    theme = 'dark',
    collapseIntrons = false,
    collapseSourceGenomeKey = '',
    collapseSourceOptions = [],
    onCollapseSourceChange = null,
    onCollapseIntronsChange = null,
}) {
    const isLight = theme === 'light'
    const canvasRef = useRef(null)
    const viewportRef = useRef(null)
    const minimapRef = useRef(null)
    const [viewWidth, setViewWidth] = useState(900)
    const [minimapWidth, setMinimapWidth] = useState(0)
    const [scrollX, setScrollX] = useState(0)
    const [zoomLevel, setZoomLevel] = useState(1)
    const [isDragging, setIsDragging] = useState(false)
    const [dragStartX, setDragStartX] = useState(0)
    const [dragStartScroll, setDragStartScroll] = useState(0)
    const [isSelectionMode, setIsSelectionMode] = useState(false)
    const [viewportSelectionRect, setViewportSelectionRect] = useState(null)
    const [minimapSelectionRect, setMinimapSelectionRect] = useState(null)
    const [hoveredExonKey, setHoveredExonKey] = useState('')
    const [selectedExonKey, setSelectedExonKey] = useState('')
    const selectionDragRef = useRef(null)

    const formatCoord = useCallback((value) => {
        const n = Number(value)
        if (!Number.isFinite(n)) return String(value || '')
        return String(Math.trunc(n))
    }, [])

    const rawRows = useMemo(
        () => (Array.isArray(result?.rows) ? result.rows : []).map(normalizeRow),
        [result?.rows]
    )
    const rawAlignmentLength = useMemo(() => {
        const reported = Number(result?.alignment_length || 0)
        if (reported > 0) return reported
        const firstLen = rawRows[0]?.sequence?.length || 0
        return Number(firstLen)
    }, [result?.alignment_length, rawRows])

    const collapsed = useMemo(
        () => buildCollapsedRows(rawRows, rawAlignmentLength, collapseSourceGenomeKey, collapseIntrons),
        [rawRows, rawAlignmentLength, collapseSourceGenomeKey, collapseIntrons]
    )

    const rows = collapsed.rows
    const visibleLength = collapsed.visibleLength
    const gapMarkers = collapsed.gapMarkers
    const consensus = useMemo(
        () => buildConsensusSequence(rows, visibleLength, String(result?.consensus || '')),
        [rows, visibleLength, result?.consensus]
    )

    const rowStripeMaps = useMemo(() => {
        const maps = new Map()
        for (const row of rows) {
            maps.set(row.genomeKey, buildCdsStripeMap(row.features, row.sequence))
        }
        return maps
    }, [rows])

    const charWidth = BASE_CHAR_WIDTH * zoomLevel
    const maxScroll = Math.max(0, visibleLength * charWidth - Math.max(0, viewWidth - LABEL_WIDTH - 8))
    const zoomLevelRef = useRef(zoomLevel)
    const scrollXRef = useRef(scrollX)
    zoomLevelRef.current = zoomLevel
    scrollXRef.current = scrollX

    useEffect(() => {
        setScrollX((prev) => clamp(prev, 0, maxScroll))
    }, [maxScroll])

    useEffect(() => {
        const el = viewportRef.current
        if (!el) return
        const update = () => {
            setViewWidth(el.clientWidth || 900)
        }
        update()
        const observer = new ResizeObserver(update)
        observer.observe(el)
        return () => observer.disconnect()
    }, [])

    useEffect(() => {
        const el = minimapRef.current
        if (!el) return
        const update = () => {
            setMinimapWidth(el.clientWidth || 0)
        }
        update()
        const observer = new ResizeObserver(update)
        observer.observe(el)
        return () => observer.disconnect()
    }, [])

    const variationMarkers = useMemo(
        () => calculateVariationMarkers(rows, consensus, visibleLength),
        [rows, consensus, visibleLength]
    )

    const jumpToPosition = useCallback((targetIndex, targetZoom = zoomLevel) => {
        const nextZoom = clamp(targetZoom, MIN_ZOOM, MAX_ZOOM)
        const nextCharWidth = BASE_CHAR_WIDTH * nextZoom
        const centerX = Math.max(0, Number(targetIndex || 0)) * nextCharWidth - (Math.max(0, viewWidth - LABEL_WIDTH - 8) / 2)
        const nextMax = Math.max(0, visibleLength * nextCharWidth - Math.max(0, viewWidth - LABEL_WIDTH - 8))
        setZoomLevel(nextZoom)
        setScrollX(clamp(centerX, 0, nextMax))
    }, [zoomLevel, viewWidth, visibleLength])

    const zoomToSelection = useCallback((rawStartIdx, rawEndIdx) => {
        if (!Number.isFinite(rawStartIdx) || !Number.isFinite(rawEndIdx)) return
        const startIdx = clamp(Math.min(rawStartIdx, rawEndIdx), 0, Math.max(0, visibleLength - 1))
        const endIdx = clamp(Math.max(rawStartIdx, rawEndIdx), 0, Math.max(0, visibleLength - 1))
        const selectedLength = Math.max(1, Math.round(endIdx - startIdx + 1))
        const usableWidth = Math.max(80, viewWidth - LABEL_WIDTH - 8)
        const fitZoom = usableWidth / Math.max(1, selectedLength * BASE_CHAR_WIDTH * 1.2)
        const targetZoom = clamp(fitZoom, MIN_ZOOM, MAX_ZOOM)
        jumpToPosition((startIdx + endIdx) / 2, targetZoom)
    }, [jumpToPosition, viewWidth, visibleLength])

    const finishSelectionDrag = useCallback((kind, startX, endX, rectWidth) => {
        const minX = clamp(Math.min(startX, endX), 0, rectWidth)
        const maxX = clamp(Math.max(startX, endX), 0, rectWidth)
        if (kind === 'viewport') {
            const contentMin = Math.max(0, minX - LABEL_WIDTH)
            const contentMax = Math.max(0, maxX - LABEL_WIDTH)
            const startIdx = (scrollXRef.current + contentMin) / Math.max(0.1, charWidth)
            const endIdx = (scrollXRef.current + contentMax) / Math.max(0.1, charWidth)
            zoomToSelection(startIdx, endIdx)
            return
        }
        const minimapContentWidth = Math.max(1, rectWidth - MINIMAP_LABEL_WIDTH)
        const contentMinX = clamp(minX - MINIMAP_LABEL_WIDTH, 0, minimapContentWidth)
        const contentMaxX = clamp(maxX - MINIMAP_LABEL_WIDTH, 0, minimapContentWidth)
        const startIdx = (contentMinX / minimapContentWidth) * visibleLength
        const endIdx = (contentMaxX / minimapContentWidth) * visibleLength
        zoomToSelection(startIdx, endIdx)
    }, [charWidth, visibleLength, zoomToSelection])

    const startSelectionDrag = useCallback((kind, clientX, rect) => {
        if (!isSelectionMode || !rect) return false
        const localX = clamp(clientX - rect.left, 0, rect.width)
        if (kind === 'viewport') {
            setViewportSelectionRect({ x1: localX, x2: localX })
        } else {
            setMinimapSelectionRect({ x1: localX, x2: localX })
        }
        selectionDragRef.current = {
            kind,
            startX: localX,
            rectLeft: rect.left,
            rectWidth: rect.width,
        }

        const handleMove = (evt) => {
            const drag = selectionDragRef.current
            if (!drag) return
            const localMoveX = clamp(evt.clientX - drag.rectLeft, 0, drag.rectWidth)
            if (drag.kind === 'viewport') {
                setViewportSelectionRect({ x1: drag.startX, x2: localMoveX })
            } else {
                setMinimapSelectionRect({ x1: drag.startX, x2: localMoveX })
            }
        }

        const handleUp = (evt) => {
            const drag = selectionDragRef.current
            selectionDragRef.current = null
            window.removeEventListener('mousemove', handleMove)
            window.removeEventListener('mouseup', handleUp)
            if (!drag) return
            const endX = clamp(evt.clientX - drag.rectLeft, 0, drag.rectWidth)
            if (Math.abs(endX - drag.startX) >= SELECTION_MIN_DRAG_PX) {
                finishSelectionDrag(drag.kind, drag.startX, endX, drag.rectWidth)
            }
            setViewportSelectionRect(null)
            setMinimapSelectionRect(null)
            setIsSelectionMode(false)
        }

        window.addEventListener('mousemove', handleMove)
        window.addEventListener('mouseup', handleUp)
        return true
    }, [finishSelectionDrag, isSelectionMode])

    useEffect(() => {
        if (!isSelectionMode) return
        const handleOutsidePointer = (evt) => {
            const target = evt.target
            if (!(target instanceof Element)) return
            if (target.closest('[data-selection-toggle="true"]')) return
            if (viewportRef.current?.contains(target)) return
            if (minimapRef.current?.contains(target)) return
            selectionDragRef.current = null
            setViewportSelectionRect(null)
            setMinimapSelectionRect(null)
            setIsSelectionMode(false)
        }
        window.addEventListener('pointerdown', handleOutsidePointer, true)
        return () => {
            window.removeEventListener('pointerdown', handleOutsidePointer, true)
        }
    }, [isSelectionMode])

    const draw = useCallback(() => {
        const canvas = canvasRef.current
        if (!canvas || !result) return
        const ctx = canvas.getContext('2d')
        if (!ctx) return

        const dpr = window.devicePixelRatio || 1
        const rowCount = rows.length
        const anyNoCoverage = rows.some((r) => r.noCoverage)
        const showPairwiseConservation = rowCount === 2 && !anyNoCoverage
        const showCnsRow = rowCount > 2 && !anyNoCoverage
        const visualRowCount = rowCount + (showPairwiseConservation ? 1 : 0) + (showCnsRow ? 1 : 0)
        const contentHeight = HEADER_HEIGHT + visualRowCount * ROW_HEIGHT + 14
        canvas.width = Math.floor(viewWidth * dpr)
        canvas.height = Math.floor(contentHeight * dpr)
        canvas.style.width = `${viewWidth}px`
        canvas.style.height = `${contentHeight}px`
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.clearRect(0, 0, viewWidth, contentHeight)

        const bg = isLight ? '#f3f4f6' : '#1a202c'
        const text = isLight ? '#374151' : '#e5e7eb'
        const subText = isLight ? '#6b7280' : '#9ca3af'
        const grid = isLight ? '#e5e7eb' : '#374151'
        const gapColor = '#ef4444'

        ctx.fillStyle = bg
        ctx.fillRect(0, 0, viewWidth, contentHeight)
        // Keep label strip unfilled so G-labels blend with surrounding panel background.
        ctx.clearRect(0, 0, LABEL_WIDTH, contentHeight)

        const xStart = LABEL_WIDTH
        const contentWidth = Math.max(0, viewWidth - xStart)
        const visibleChars = Math.max(1, Math.floor(contentWidth / Math.max(0.1, charWidth)))
        const startPos = Math.max(0, Math.floor(scrollX / Math.max(0.1, charWidth)))
        const endPos = Math.min(visibleLength, startPos + visibleChars + 4)
        const useBlockMode = zoomLevel < BLOCK_THRESHOLD

        ctx.strokeStyle = grid
        ctx.lineWidth = 1
        for (let r = 0; r <= visualRowCount; r += 1) {
            const y = HEADER_HEIGHT + r * ROW_HEIGHT
            ctx.beginPath()
            ctx.moveTo(0, y + 0.5)
            ctx.lineTo(viewWidth, y + 0.5)
            ctx.stroke()
        }

        const tickSpacing = zoomLevel < 0.05 ? 500 : zoomLevel < 0.1 ? 250 : zoomLevel < 0.2 ? 100 : zoomLevel < 0.5 ? 50 : 10
        ctx.fillStyle = subText
        ctx.font = '11px monospace'
        const firstTick = Math.ceil((startPos + 1) / tickSpacing) * tickSpacing - 1
        for (let i = firstTick; i < endPos; i += tickSpacing) {
            const x = xStart + (i - startPos) * charWidth
            if (x < xStart) continue
            ctx.fillText(String(i + 1), x, 12)
            ctx.fillRect(x, 16, 1, 6)
        }

        const drawSequenceRow = (row, y) => {
            const cdsStripeMap = rowStripeMaps.get(row.genomeKey)
            const hasCoverageWindow = !row.noCoverage && Number.isFinite(row.coveredColumnStart) && Number.isFinite(row.coveredColumnEnd)
            const coveredStart = hasCoverageWindow ? Math.max(0, Math.min(row.coveredColumnStart, row.coveredColumnEnd)) : null
            const coveredEnd = hasCoverageWindow ? Math.max(row.coveredColumnStart, row.coveredColumnEnd) : null
            ctx.fillStyle = text
            ctx.font = '12px monospace'
            ctx.textAlign = 'left'
            ctx.textBaseline = 'alphabetic'
            ctx.fillText(row.tag, 5, y + 16)

            if (useBlockMode) {
                let currentStart = startPos
                let firstBase = row.sequence?.[startPos] || ''
                const firstCovered = !row.noCoverage && (!hasCoverageWindow || (startPos >= coveredStart && startPos <= coveredEnd))
                let currentIsGap = firstBase === '-'
                let currentColor = !firstCovered
                    ? bg
                    : currentIsGap
                    ? bg
                    : getColorAt(row.features, startPos, row.sequence, cdsStripeMap)
                for (let i = startPos + 1; i <= endPos; i += 1) {
                    const base = i < endPos ? (row.sequence?.[i] || '') : ''
                    const isCovered = i < endPos ? (!row.noCoverage && (!hasCoverageWindow || (i >= coveredStart && i <= coveredEnd))) : false
                    const isGap = i < endPos ? base === '-' : false
                    const color = i < endPos
                        ? (!isCovered ? bg : (isGap ? bg : getColorAt(row.features, i, row.sequence, cdsStripeMap)))
                        : null
                    if (isGap !== currentIsGap || color !== currentColor || i === endPos) {
                        const x1 = xStart + (currentStart - startPos) * charWidth
                        const x2 = xStart + (i - startPos) * charWidth
                        ctx.fillStyle = currentColor
                        ctx.fillRect(x1, y + 2, Math.max(1, x2 - x1), ROW_HEIGHT - 4)
                        if (currentIsGap) {
                            ctx.fillStyle = gapColor
                            ctx.fillRect(x1, y + Math.floor(ROW_HEIGHT / 2) - 1, Math.max(1, x2 - x1), 2)
                        }
                        currentStart = i
                        currentIsGap = isGap
                        currentColor = color
                    }
                }
            } else {
                ctx.save()
                ctx.textAlign = 'center'
                ctx.textBaseline = 'middle'
                ctx.font = '12px monospace'
                for (let i = startPos; i < endPos; i += 1) {
                    const x = xStart + (i - startPos) * charWidth
                    const base = row.sequence?.[i] || ''
                    const isCovered = !row.noCoverage && (!hasCoverageWindow || (i >= coveredStart && i <= coveredEnd))
                    const isGap = base === '-'
                    const bgColor = !isCovered
                        ? bg
                        : isGap
                        ? bg
                        : getColorAt(row.features, i, row.sequence, cdsStripeMap)
                    ctx.fillStyle = bgColor
                    ctx.fillRect(x, y + 2, charWidth, ROW_HEIGHT - 4)

                    const isDarkBg = hexLuminance(bgColor) < 0.46
                    if (!isCovered) {
                        continue
                    } else if (isGap) {
                        ctx.fillStyle = gapColor
                    } else {
                        ctx.fillStyle = isLight ? (isDarkBg ? '#e2e8f0' : '#1f2937') : '#e2e8f0'
                        if (!isLight && !isDarkBg) ctx.fillStyle = '#1f2937'
                    }
                    ctx.fillText(base, x + charWidth / 2, y + ROW_HEIGHT / 2)
                }
                ctx.restore()
            }

            if (row.notAlignedBpLeft > 0 || row.notAlignedBpRight > 0) {
                ctx.save()
                ctx.font = '10px sans-serif'
                ctx.textBaseline = 'middle'
                ctx.fillStyle = '#ef4444'
                if (row.notAlignedBpLeft > 0) {
                    ctx.textAlign = 'left'
                    ctx.fillText(`${Math.round(row.notAlignedBpLeft)}bp not aligned`, xStart + 6, y + 8)
                }
                if (row.notAlignedBpRight > 0) {
                    ctx.textAlign = 'right'
                    ctx.fillText(`${Math.round(row.notAlignedBpRight)}bp not aligned`, viewWidth - 8, y + 8)
                }
                ctx.restore()
            }


        }

        const drawPairwiseConservationRow = (rowA, rowB, y) => {
            const MATCH_COLOR = '#3b82f6'
            const MISMATCH_COLOR = '#ef4444'
            const GAP_COLOR = '#ef4444'

            if (useBlockMode) {
                const windowSize = Math.max(1, Math.floor(1 / zoomLevel))
                for (let i = startPos; i < endPos; i += windowSize) {
                    const x = xStart + (i - startPos) * charWidth
                    const blockWidth = Math.max(1, windowSize * charWidth)
                    let matches = 0
                    let mismatches = 0
                    let gaps = 0
                    for (let j = i; j < Math.min(i + windowSize, endPos); j += 1) {
                        const a = rowA.sequence?.[j] || ''
                        const b = rowB.sequence?.[j] || ''
                        if (a === b && a !== '-') {
                            matches += 1
                        } else if (a === '-' || b === '-') {
                            gaps += 1
                        } else {
                            mismatches += 1
                        }
                    }
                    const total = matches + mismatches + gaps
                    const matchRatio = total > 0 ? matches / total : 0

                    let color
                    if (matchRatio >= 0.95) {
                        color = '#3b82f6'
                    } else if (matchRatio >= 0.8) {
                        const t = (matchRatio - 0.8) / 0.15
                        const r = Math.round(59 + (1 - t) * 30)
                        const g = Math.round(130 + (1 - t) * 40)
                        const b = Math.round(246 - (1 - t) * 20)
                        color = `rgb(${r},${g},${b})`
                    } else if (matchRatio >= 0.5) {
                        const t = (matchRatio - 0.5) / 0.3
                        const r = Math.round(239 - t * 60)
                        const g = Math.round(130 + t * 40)
                        const b = Math.round(68 + t * 80)
                        color = `rgb(${r},${g},${b})`
                    } else {
                        const t = matchRatio / 0.5
                        const r = Math.round(200 + t * 39)
                        const g = Math.round(50 + t * 18)
                        const b = Math.round(50 + t * 18)
                        color = `rgb(${r},${g},${b})`
                    }
                    ctx.fillStyle = color
                    ctx.fillRect(x, y + 4, blockWidth, ROW_HEIGHT - 8)
                }
                return
            }

            ctx.save()
            ctx.textAlign = 'center'
            ctx.textBaseline = 'middle'
            ctx.font = '12px monospace'
            for (let i = startPos; i < endPos; i += 1) {
                const x = xStart + (i - startPos) * charWidth
                const a = rowA.sequence?.[i] || ''
                const b = rowB.sequence?.[i] || ''
                let symbol = ' '
                let color = isLight ? '#1f2937' : '#e2e8f0'
                if (a === b && a !== '-') {
                    symbol = '|'
                    color = MATCH_COLOR
                } else if (a === '-' || b === '-') {
                    symbol = '−'
                    color = GAP_COLOR
                } else {
                    symbol = '×'
                    color = MISMATCH_COLOR
                }
                ctx.fillStyle = color
                ctx.fillText(symbol, x + charWidth / 2, y + ROW_HEIGHT / 2)
            }
            ctx.restore()
        }

        const getCnsMarker = (idx) => {
            const counts = new Map()
            let nonGap = 0
            let gapCount = 0
            for (const row of rows) {
                const ch = String(row.sequence?.[idx] || '-').toUpperCase()
                if (ch === '-') {
                    gapCount += 1
                    continue
                }
                nonGap += 1
                counts.set(ch, (counts.get(ch) || 0) + 1)
            }
            if (nonGap <= 0 || counts.size === 0) return { symbol: ' ', score: 0 }
            let maxCount = 0
            for (const count of counts.values()) {
                if (count > maxCount) maxCount = count
            }
            const hasGaps = gapCount > 0
            const allSame = counts.size === 1
            if (allSame && !hasGaps && nonGap === rowCount) return { symbol: '*', score: 1.0 }
            if (allSame) return { symbol: ':', score: 0.82 }
            const dominantRatio = maxCount / Math.max(1, nonGap)
            if (dominantRatio >= 0.8) return { symbol: ':', score: 0.65 }
            if (dominantRatio >= 0.6) return { symbol: '.', score: 0.42 }
            return { symbol: ' ', score: 0.08 }
        }

        const drawCnsRow = (y) => {
            ctx.fillStyle = isLight ? '#374151' : '#94a3b8'
            ctx.font = '12px monospace'
            ctx.textAlign = 'left'
            ctx.textBaseline = 'alphabetic'
            ctx.fillText('CNS', 5, y + 16)

            if (useBlockMode) {
                const windowSize = quantizedWindowSizeByPixels(charWidth, 12, 1, 1024)
                const CONSERVED_RATIO_THRESHOLD = 0.7
                let runStart = -1
                let runEnd = -1
                let runTotalBp = 0

                const flushRun = () => {
                    if (runStart < 0 || runEnd <= runStart || runTotalBp <= 0) return
                    ctx.fillStyle = '#60a5fa'
                    const x1 = xStart + (runStart - startPos) * charWidth
                    const x2 = xStart + (runEnd - startPos) * charWidth
                    ctx.fillRect(x1, y + 4, Math.max(1, x2 - x1), ROW_HEIGHT - 8)
                    runStart = -1
                    runEnd = -1
                    runTotalBp = 0
                }

                const globalEnd = Math.max(0, visibleLength)
                const firstBinStart = Math.floor(startPos / windowSize) * windowSize
                const lastBinStart = Math.floor(Math.max(0, endPos - 1) / windowSize) * windowSize

                for (let i = firstBinStart; i <= lastBinStart; i += windowSize) {
                    const binEnd = Math.min(i + windowSize, globalEnd)
                    if (binEnd <= i) continue

                    let fullyConserved = 0
                    let total = 0
                    for (let j = i; j < binEnd; j += 1) {
                        total += 1
                        if (getCnsMarker(j).symbol === '*') fullyConserved += 1
                    }
                    const conservedRatio = total > 0 ? (fullyConserved / total) : 0
                    const isConservedWindow = conservedRatio >= CONSERVED_RATIO_THRESHOLD
                    const visibleSegStart = Math.max(i, startPos)
                    const visibleSegEnd = Math.min(binEnd, endPos)
                    const visibleBp = Math.max(0, visibleSegEnd - visibleSegStart)

                    if (isConservedWindow) {
                        if (visibleBp <= 0) continue
                        if (runStart < 0) runStart = visibleSegStart
                        runEnd = visibleSegEnd
                        runTotalBp += visibleBp
                    } else {
                        flushRun()
                    }
                }
                flushRun()
                return
            }

            ctx.save()
            ctx.textAlign = 'center'
            ctx.textBaseline = 'middle'
            ctx.font = '12px monospace'
            for (let i = startPos; i < endPos; i += 1) {
                const x = xStart + (i - startPos) * charWidth
                const marker = getCnsMarker(i)
                let color = isLight ? '#94a3b8' : '#64748b'
                if (marker.symbol === '*') color = '#3b82f6'
                else if (marker.symbol === ':') color = '#60a5fa'
                else if (marker.symbol === '.') color = '#93c5fd'
                ctx.fillStyle = color
                ctx.fillText(marker.symbol, x + charWidth / 2, y + ROW_HEIGHT / 2)
            }
            ctx.restore()
        }

        if (showPairwiseConservation) {
            drawSequenceRow(rows[0], HEADER_HEIGHT)
            drawPairwiseConservationRow(rows[0], rows[1], HEADER_HEIGHT + ROW_HEIGHT)
            drawSequenceRow(rows[1], HEADER_HEIGHT + ROW_HEIGHT * 2)
        } else {
            rows.forEach((row, rowIdx) => {
                drawSequenceRow(row, HEADER_HEIGHT + rowIdx * ROW_HEIGHT)
            })
        }
        if (showCnsRow) {
            drawCnsRow(HEADER_HEIGHT + rowCount * ROW_HEIGHT)
        }

        if (gapMarkers?.length > 0) {
            const firstY = HEADER_HEIGHT
            const lastY = HEADER_HEIGHT + visualRowCount * ROW_HEIGHT
            for (const gap of gapMarkers) {
                if (gap.position < startPos || gap.position >= endPos) continue
                const x = xStart + (gap.position - startPos) * charWidth
                ctx.strokeStyle = '#f59e0b'
                ctx.lineWidth = 2
                ctx.beginPath()
                const steps = Math.max(2, rows.length + 1)
                const height = Math.max(6, (lastY - firstY) / steps)
                let y = firstY
                ctx.moveTo(x, y)
                for (let i = 0; i < steps; i += 1) {
                    y += height * 0.5
                    ctx.lineTo(x + 3, y)
                    y += height * 0.5
                    ctx.lineTo(x - 3, y)
                }
                ctx.stroke()
                ctx.fillStyle = '#f59e0b'
                ctx.font = '9px sans-serif'
                ctx.fillText(`${gap.count}bp`, x - 10, HEADER_HEIGHT - 5)
            }
        }
    }, [
        result,
        rows,
        consensus,
        rowStripeMaps,
        scrollX,
        zoomLevel,
        charWidth,
        viewWidth,
        visibleLength,
        gapMarkers,
        isLight,
    ])

    useEffect(() => {
        draw()
    }, [draw])

    const handleMouseDown = useCallback((e) => {
        if (isSelectionMode) {
            const rect = viewportRef.current?.getBoundingClientRect()
            const started = startSelectionDrag('viewport', e.clientX, rect || null)
            if (started) return
        }
        setIsDragging(true)
        setDragStartX(e.clientX)
        setDragStartScroll(scrollX)
    }, [scrollX, isSelectionMode, startSelectionDrag])

    const handleMouseMove = useCallback((e) => {
        if (!isDragging) return
        const dx = e.clientX - dragStartX
        setScrollX(clamp(dragStartScroll - dx, 0, maxScroll))
    }, [isDragging, dragStartX, dragStartScroll, maxScroll])

    const handleMouseUp = useCallback(() => {
        setIsDragging(false)
    }, [])

    const handleWheel = useCallback((e) => {
        if (!result) return
        e.preventDefault()
        e.stopPropagation()

        let currentZoom = zoomLevelRef.current
        let currentScrollX = scrollXRef.current
        const isPinch = Boolean(e.ctrlKey || e.metaKey)
        const absX = Math.abs(Number(e.deltaX || 0))
        const absY = Math.abs(Number(e.deltaY || 0))
        const isVertical = absY > absX
        const isHorizontal = absX >= absY

        if (isPinch || (isVertical && absY > 0.5)) {
            const rect = viewportRef.current?.getBoundingClientRect()
            const localXRaw = rect ? (e.clientX - rect.left - LABEL_WIDTH) : 0
            const localX = Math.max(0, localXRaw)
            const currentCharWidth = BASE_CHAR_WIDTH * currentZoom
            const centerChar = (currentScrollX + localX) / Math.max(0.1, currentCharWidth)
            const sensitivity = isPinch ? 0.01 : 0.005
            const zoomFactor = 1 - Number(e.deltaY || 0) * sensitivity
            const nextZoom = clamp(currentZoom * zoomFactor, MIN_ZOOM, MAX_ZOOM)
            const nextCharWidth = BASE_CHAR_WIDTH * nextZoom
            const nextMaxScroll = Math.max(0, visibleLength * nextCharWidth - Math.max(0, viewWidth - LABEL_WIDTH - 8))
            currentScrollX = clamp(centerChar * nextCharWidth - localX, 0, nextMaxScroll)
            currentZoom = nextZoom
        } else if (isHorizontal || e.shiftKey) {
            const panDelta = Number(e.deltaX || 0) + (e.shiftKey ? Number(e.deltaY || 0) : 0)
            currentScrollX = clamp(currentScrollX + panDelta, 0, maxScroll)
        }

        zoomLevelRef.current = currentZoom
        scrollXRef.current = currentScrollX
        setZoomLevel(currentZoom)
        setScrollX(currentScrollX)
    }, [result, visibleLength, viewWidth, maxScroll])

    useEffect(() => {
        const el = viewportRef.current
        if (!el) return
        const onWheelNative = (evt) => handleWheel(evt)
        el.addEventListener('wheel', onWheelNative, { passive: false })
        return () => {
            el.removeEventListener('wheel', onWheelNative)
        }
    }, [handleWheel])

    const stats = useMemo(() => {
        const avgIdentity = Number(result?.average_identity || 0)
        let gaps = 0
        for (let i = 0; i < visibleLength; i += 1) {
            const cons = consensus[i] || '-'
            for (const row of rows) {
                const ch = row.sequence?.[i] || '-'
                if (ch === '-' || cons === '-') gaps += 1
            }
        }
        return {
            avgIdentity,
            gaps,
            length: visibleLength,
            genomes: rows.length,
        }
    }, [result?.average_identity, rows, consensus, visibleLength])

    const minimapHeight = Math.max(56, 14 + rows.length * 22 + 6)
    const minimapContentWidth = Math.max(1, minimapWidth - MINIMAP_LABEL_WIDTH)
    const totalContentWidthPx = Math.max(1, visibleLength * charWidth)
    const viewportContentWidthPx = Math.max(1, viewWidth - LABEL_WIDTH - 8)
    const viewportWidthPx = clamp(
        (viewportContentWidthPx / totalContentWidthPx) * minimapContentWidth,
        1,
        minimapContentWidth
    )
    const viewportLeftPx = clamp(
        (scrollX / totalContentWidthPx) * minimapContentWidth,
        0,
        Math.max(0, minimapContentWidth - viewportWidthPx)
    )
    const collapseDropdownValue = collapseIntrons
        ? (String(collapseSourceGenomeKey || '').trim() || '__off__')
        : '__prompt__'

    return (
        <div className={`${isLight ? 'bg-white border border-gray-200 shadow-sm' : 'bg-gray-800'} rounded-lg overflow-hidden flex flex-col`}>
            <div className={`px-4 py-3 border-b ${isLight ? 'bg-gray-100 border-gray-200' : 'bg-gray-850 border-gray-700'}`}>
                <div className="space-y-2">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className={`flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] ${isLight ? 'text-gray-600' : 'text-gray-300'}`}>
                            <div className="inline-flex items-center gap-1.5">
                                <span>Identity</span>
                                <span className={`font-semibold ${stats.avgIdentity >= 95 ? 'text-green-500' : stats.avgIdentity >= 80 ? 'text-yellow-500' : 'text-red-500'}`}>
                                    {stats.avgIdentity.toFixed(2)}%
                                </span>
                            </div>
                            <div className="inline-flex items-center gap-1.5">
                                <span>Gaps</span>
                                <span className="font-semibold">{stats.gaps}</span>
                            </div>
                            <div className="inline-flex items-center gap-1.5">
                                <span>Length</span>
                                <span className="font-semibold">{stats.length}</span>
                            </div>
                            <div className="inline-flex items-center gap-1.5">
                                <span>Genomes</span>
                                <span className="font-semibold">{stats.genomes}</span>
                            </div>
                        </div>

                        <div className={`pl-2 border-l ${isLight ? 'border-gray-300' : 'border-gray-600'} space-y-1.5`}>
                            <div className="flex items-center gap-2">
                            <button
                                data-selection-toggle="true"
                                className={`w-8 h-7 rounded transition-colors flex items-center justify-center ${isSelectionMode
                                    ? (isLight ? 'bg-[#0099ff] text-white' : 'bg-blue-600 text-white')
                                    : (isLight ? 'bg-gray-200 hover:bg-gray-300 text-gray-700' : 'bg-gray-700 hover:bg-gray-600 text-gray-200')
                                    }`}
                                onClick={() => {
                                    setIsSelectionMode((prev) => !prev)
                                    setViewportSelectionRect(null)
                                    setMinimapSelectionRect(null)
                                }}
                                title={isSelectionMode ? 'Selection mode active: drag on alignment or minimap to zoom' : 'Activate selection mode to drag-select and zoom'}
                            >
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
                                    <rect x="2.5" y="2.5" width="16" height="16" rx="2.2" strokeWidth="2.2" strokeDasharray="3.2 2.2" />
                                    <path d="M21 16.8v5.2M18.4 19.4h5.2" strokeWidth="2.2" />
                                </svg>
                            </button>
                            <select
                                value={collapseDropdownValue}
                                onChange={(e) => {
                                    const next = String(e.target.value || '')
                                    if (next === '__prompt__' || next === '__off__') {
                                        onCollapseIntronsChange?.(false)
                                        return
                                    }
                                    onCollapseSourceChange?.(next)
                                    onCollapseIntronsChange?.(true)
                                }}
                                className={`h-7 min-w-[148px] rounded px-2 text-[11px] border ${isLight ? 'bg-gray-50 border-gray-300 text-gray-900' : 'bg-gray-700 border-gray-600 text-white'}`}
                                title="Collapse introns source genome"
                            >
                                <option value="__prompt__" hidden>Collapse introns</option>
                                <option value="__off__">Don't collapse</option>
                                {(collapseSourceOptions || []).map((option) => (
                                    <option key={option.genome_key} value={option.genome_key}>
                                        {option.tag} {option.label}
                                    </option>
                                ))}
                            </select>
                            </div>
                            <div className="flex items-center gap-2">
                            <button
                                className={`w-8 h-7 rounded transition-colors flex items-center justify-center ${isLight ? 'bg-gray-200 hover:bg-gray-300 text-gray-700' : 'bg-gray-700 hover:bg-gray-600 text-gray-200'}`}
                                onClick={() => {
                                    const centerChar = (scrollX + Math.max(0, viewWidth - LABEL_WIDTH - 8) / 2) / Math.max(0.1, charWidth)
                                    const nextCharWidth = BASE_CHAR_WIDTH * MAX_ZOOM
                                    setZoomLevel(MAX_ZOOM)
                                    setScrollX(clamp(centerChar * nextCharWidth - Math.max(0, viewWidth - LABEL_WIDTH - 8) / 2, 0, Math.max(0, visibleLength * nextCharWidth - Math.max(0, viewWidth - LABEL_WIDTH - 8))))
                                }}
                                title="Zoom to sequence view"
                            >
                                <svg className="w-5 h-5" viewBox="0 0 24 24">
                                    <circle cx="10" cy="10" r="8" fill="none" stroke={isLight ? '#0099ff' : '#3b82f6'} strokeWidth="2.5" />
                                    <line x1="16" y1="16" x2="22" y2="22" stroke={isLight ? '#0099ff' : '#3b82f6'} strokeWidth="2.5" strokeLinecap="round" />
                                    <text x="10" y="14" textAnchor="middle" fontSize="10" fontWeight="bold" fill={isLight ? '#0099ff' : '#3b82f6'}>A</text>
                                </svg>
                            </button>
                            <input
                                type="range"
                                min={MIN_ZOOM * 100}
                                max={MAX_ZOOM * 100}
                                value={zoomLevel * 100}
                                onChange={(e) => {
                                    const centerChar = (scrollX + Math.max(0, viewWidth - LABEL_WIDTH - 8) / 2) / Math.max(0.1, charWidth)
                                    const nextZoom = clamp(parseFloat(e.target.value) / 100, MIN_ZOOM, MAX_ZOOM)
                                    const nextCharWidth = BASE_CHAR_WIDTH * nextZoom
                                    setZoomLevel(nextZoom)
                                    setScrollX(clamp(centerChar * nextCharWidth - Math.max(0, viewWidth - LABEL_WIDTH - 8) / 2, 0, Math.max(0, visibleLength * nextCharWidth - Math.max(0, viewWidth - LABEL_WIDTH - 8))))
                                }}
                                className={`w-24 h-2 rounded-lg cursor-pointer ${isLight ? 'light-slider' : 'dark-slider'}`}
                                title="Drag to adjust zoom"
                            />
                            <div className="text-sm font-medium text-blue-400 min-w-[42px] text-right">{Math.round(zoomLevel * 100)}%</div>
                            </div>
                        </div>
                    </div>
                    <div className="min-w-0 space-y-1">
                        {rows.map((row, idx) => {
                            const coordLabel = row.chrom
                                ? `${row.chrom}:${formatCoord(row.genomicStart)}-${formatCoord(row.genomicEnd)} (${row.strand})`
                                : ''
                            const transcriptLabel = row.transcriptId || 'No transcript selected'
                            return (
                                <div
                                    key={`hdr-${row.genomeKey}-${idx}`}
                                    className={`text-[11px] leading-4 font-mono whitespace-normal break-all ${idx === 0 ? (isLight ? 'text-gray-900' : 'text-white') : (isLight ? 'text-gray-700' : 'text-gray-300')}`}
                                >
                                    {row.tag}: {coordLabel || 'No alignment coordinates'}, {transcriptLabel}
                                </div>
                            )
                        })}
                    </div>
                </div>
            </div>

            <div
                ref={viewportRef}
                className={`px-4 py-4 select-none relative overflow-y-auto overflow-x-hidden ${isSelectionMode ? 'cursor-crosshair' : 'cursor-grab active:cursor-grabbing'}`}
                style={{ maxHeight: '440px' }}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseUp}
            >
                <canvas ref={canvasRef} className="rounded" />
                {viewportSelectionRect && (
                    <div
                        className="absolute border border-yellow-400 bg-yellow-300/10 pointer-events-none"
                        style={{
                            left: `${Math.min(viewportSelectionRect.x1, viewportSelectionRect.x2)}px`,
                            width: `${Math.max(1, Math.abs(viewportSelectionRect.x2 - viewportSelectionRect.x1))}px`,
                            top: '16px',
                            bottom: '16px',
                        }}
                    />
                )}
            </div>

            <div className="px-4 py-0 mb-1">
                <div
                    ref={minimapRef}
                    className={`relative ${isLight ? 'bg-gray-200' : 'bg-gray-750'} rounded ${isSelectionMode ? 'cursor-crosshair' : 'cursor-pointer'}`}
                    style={{ height: `${minimapHeight}px` }}
                    onMouseDown={(e) => {
                        if (!isSelectionMode) return
                        const rect = e.currentTarget.getBoundingClientRect()
                        startSelectionDrag('minimap', e.clientX, rect)
                    }}
                    onClick={(e) => {
                        if (isSelectionMode) return
                        const rect = e.currentTarget.getBoundingClientRect()
                        const clickX = e.clientX - rect.left - MINIMAP_LABEL_WIDTH
                        const usableWidth = Math.max(1, rect.width - MINIMAP_LABEL_WIDTH)
                        const clickPercent = Math.max(0, clickX) / usableWidth
                        const targetIdx = clickPercent * visibleLength
                        const targetScrollX = targetIdx * charWidth - Math.max(0, viewWidth - LABEL_WIDTH - 8) / 2
                        setScrollX(clamp(targetScrollX, 0, maxScroll))
                    }}
                >
                    <div className="absolute right-0 h-3" style={{ top: '0px', left: `${MINIMAP_LABEL_WIDTH}px` }}>
                        <svg className="w-full h-full" viewBox="0 0 100 12" preserveAspectRatio="none">
                            {variationMarkers.map((marker, idx) => {
                                if (marker.type === 'triangle') {
                                    const xPos = (marker.position / Math.max(1, visibleLength)) * 100
                                    const triWidth = 0.8
                                    return (
                                        <polygon
                                            key={`var-tri-${idx}`}
                                            points={`${xPos - triWidth / 2},0 ${xPos + triWidth / 2},0 ${xPos},10`}
                                            fill="#ef4444"
                                            style={{ cursor: 'pointer' }}
                                            onClick={(e) => {
                                                e.stopPropagation()
                                                jumpToPosition(marker.position, MAX_ZOOM)
                                            }}
                                        />
                                    )
                                }
                                const startPos = (marker.start / Math.max(1, visibleLength)) * 100
                                const blockWidth = ((marker.end - marker.start + 1) / Math.max(1, visibleLength)) * 100
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
                                        onClick={(e) => {
                                            e.stopPropagation()
                                            jumpToPosition((marker.start + marker.end) / 2, MAX_ZOOM)
                                        }}
                                    />
                                )
                            })}
                        </svg>
                    </div>

                    {rows.map((row, idx) => {
                        const topPx = 14 + idx * 22
                        const exons = row.features.filter((f) => f.type === 'exon')
                        const fallbackExons = exons.length > 0 ? exons : row.features.filter((f) => f.type === 'cds')
                        const rowExons = fallbackExons
                        const firstExon = rowExons[0]
                        const lastExon = rowExons[rowExons.length - 1]
                        return (
                            <div key={`minimap-row-${row.genomeKey}`} className="absolute right-0 h-5" style={{ top: `${topPx}px`, left: `${MINIMAP_LABEL_WIDTH}px` }}>
                                <span
                                    className="absolute top-0 text-xs font-medium pointer-events-none"
                                    style={{
                                        right: '100%',
                                        paddingRight: '4px',
                                        width: `${MINIMAP_LABEL_WIDTH}px`,
                                        textAlign: 'left',
                                        color: isLight ? '#6b7280' : '#9ca3af',
                                    }}
                                >{row.tag}</span>
                                {row.notAlignedBpLeft > 0 && (
                                    <span className="absolute left-1 top-0 text-[10px] text-red-500 whitespace-nowrap pointer-events-none">
                                        {Math.round(row.notAlignedBpLeft)}bp not aligned
                                    </span>
                                )}
                                {row.notAlignedBpRight > 0 && (
                                    <span className="absolute right-1 top-0 text-[10px] text-red-500 whitespace-nowrap pointer-events-none">
                                        {Math.round(row.notAlignedBpRight)}bp not aligned
                                    </span>
                                )}
                                <svg className="w-full h-full" preserveAspectRatio="none">
                                    {!collapseIntrons && firstExon && lastExon && (
                                        <line
                                            x1={`${(firstExon.start / Math.max(1, visibleLength)) * 100}%`}
                                            y1="50%"
                                            x2={`${(lastExon.end / Math.max(1, visibleLength)) * 100}%`}
                                            y2="50%"
                                            stroke="#4a5568"
                                            strokeWidth="2"
                                        />
                                    )}
                                    {rowExons.map((exon, exonIdx) => (
                                        (() => {
                                            const exonKey = `${row.genomeKey}:${exon.start}-${exon.end}`
                                            const isHovered = hoveredExonKey === exonKey
                                            const isSelected = selectedExonKey === exonKey
                                            return (
                                                <rect
                                                    key={`exon-${row.genomeKey}-${exonIdx}`}
                                                    x={`${(exon.start / Math.max(1, visibleLength)) * 100}%`}
                                                    y="10%"
                                                    width={`${((exon.end - exon.start + 1) / Math.max(1, visibleLength)) * 100}%`}
                                                    height="80%"
                                                    fill={isSelected ? '#60a5fa' : '#4299e1'}
                                                    stroke={isHovered || isSelected ? '#ffffff' : 'none'}
                                                    strokeWidth={isHovered || isSelected ? 1.2 : 0}
                                                    rx="2"
                                                    style={{ cursor: 'pointer' }}
                                                    onMouseEnter={() => setHoveredExonKey(exonKey)}
                                                    onMouseLeave={() => setHoveredExonKey((prev) => (prev === exonKey ? '' : prev))}
                                                    onClick={(e) => {
                                                        e.stopPropagation()
                                                        setSelectedExonKey(exonKey)
                                                        const exonWidth = exon.end - exon.start + 1
                                                        const zoomForFull = (Math.max(100, viewWidth - LABEL_WIDTH - 8) / Math.max(1, exonWidth * BASE_CHAR_WIDTH * 1.2))
                                                        const targetZoom = zoomForFull >= MAX_ZOOM
                                                            ? MAX_ZOOM
                                                            : Math.min(BLOCK_THRESHOLD * 0.95, zoomForFull)
                                                        jumpToPosition((exon.start + exon.end) / 2, targetZoom)
                                                    }}
                                                />
                                            )
                                        })()
                                    ))}
                                </svg>
                            </div>
                        )
                    })}

                    <div
                        className="absolute top-0 bottom-0 bg-white/10 border-l border-r border-blue-400 pointer-events-none"
                        style={{
                            left: `${MINIMAP_LABEL_WIDTH + viewportLeftPx}px`,
                            width: `${viewportWidthPx}px`,
                        }}
                    />
                    {minimapSelectionRect && (
                        <div
                            className="absolute top-0 bottom-0 border border-yellow-400 bg-yellow-300/10 pointer-events-none"
                            style={{
                                left: `${Math.min(minimapSelectionRect.x1, minimapSelectionRect.x2)}px`,
                                width: `${Math.max(1, Math.abs(minimapSelectionRect.x2 - minimapSelectionRect.x1))}px`,
                            }}
                        />
                    )}
                </div>

                {rows.some((r) => r.boundaryStatus === 'partial' || r.boundaryStatus === 'outside') && (
                    <div className="mt-1 space-y-0.5">
                        {rows.filter((r) => r.boundaryStatus === 'partial' || r.boundaryStatus === 'outside').map((row) => (
                            <div
                                key={`boundary-msg-${row.genomeKey}`}
                                className="text-[11px] text-center"
                                style={{
                                    color: row.boundaryStatus === 'partial' ? '#f59e0b' : '#ef4444',
                                }}
                            >
                                {row.tag}: {row.boundaryMessage || (row.boundaryStatus === 'partial' ? 'Transcript partially overlaps alignment boundaries' : 'Transcript outside alignment boundaries')}
                            </div>
                        ))}
                    </div>
                )}
            </div>

            <div className="px-4 pb-3">
                <div
                    className={`h-3 ${isLight ? 'bg-gray-300' : 'bg-gray-700'} rounded-full overflow-hidden cursor-pointer relative`}
                    onMouseDown={(e) => {
                        const thumbWidth = 60
                        const rect = e.currentTarget.getBoundingClientRect()
                        const clickX = e.clientX - rect.left
                        const trackWidth = rect.width
                        const effectiveTrack = Math.max(1, trackWidth - thumbWidth)
                        const clickPercent = clamp((clickX - thumbWidth / 2) / effectiveTrack, 0, 1)
                        setScrollX(clickPercent * maxScroll)

                        const handleDrag = (moveEvent) => {
                            const newX = moveEvent.clientX - rect.left
                            const newPercent = clamp((newX - thumbWidth / 2) / effectiveTrack, 0, 1)
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
                            width: '60px',
                            marginLeft: (() => {
                                if (maxScroll <= 0) return '0px'
                                const scrollPercent = scrollX / maxScroll
                                return `${scrollPercent * Math.max(0, (viewWidth - 8 - 60))}px`
                            })(),
                        }}
                    />
                </div>
            </div>
        </div>
    )
}

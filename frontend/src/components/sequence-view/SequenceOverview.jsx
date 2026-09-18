import { useEffect, useMemo, useRef } from 'react'

import { displayRow } from '../../utils/sequenceViewDisplay'
import { buildRowClasses, EDGE_PREVIEW, geneEdgeMaskForRow } from '../../utils/sequenceViewClasses'
import { CLASS_CODES, CLASS_GAP, CLASS_NONE } from '../../utils/sequenceViewPalette'
import { gutterEvery, gutterLabel } from '../../utils/sequenceViewZoom'
import { FONT_MONO } from '../../utils/typography'

/** How much of a base is left showing when the pointer is on something else.
 *  The same value the readable view dims by, so the two look like one thing. */
const DIMMED = 0.22

/**
 * The sequence drawn from a distance.
 *
 * One canvas, one rectangle per base, no letters and no elements. Everything it
 * draws it takes from the same places the readable view does -- the record's
 * layout for what a column holds, `buildRowClasses` for what a base is, the
 * reader's palette for what colour that makes it -- so zooming out changes how
 * much of the annotation is on screen and nothing about what it says.
 *
 * Why a canvas at all: the readable view is an element per base, which is what
 * makes it clickable and selectable and is affordable at sixty a row and forty
 * rows. A quarter of the size is four times the rows on screen, and at the far
 * end of the range it is ten times; the same approach there is tens of thousands
 * of elements repainted on every scroll frame. So the far view gives up the
 * things that needed elements -- selecting, clicking a base, the hover tip --
 * and keeps the two that answer the question it exists for: the colours, and
 * where they fall relative to each other.
 *
 * It keeps the dimming as well. Pointing at a feature in the list beside the
 * sequence is *more* useful here than close up, because the whole of a gene can
 * be on screen at once for the first time.
 */
export default function SequenceOverview({
    doc,
    rows,
    viewFor,
    geometry,
    model,
    palette,
    isLight,
    preview = null,
    width,
    height,
    offsetPx,
}) {
    const canvas = useRef(null)

    // The colour of every class, resolved once rather than per base. A row is
    // sixty lookups and a screenful is thousands of them, and the answer only
    // changes when the reader changes their palette -- so the whole table is
    // built up front rather than filled in as codes turn up.
    const colours = useMemo(() => {
        const table = new Map()
        for (const code of Object.values(CLASS_CODES)) {
            const style = palette.style(code)
            if (style?.bg) table.set(code, style.bg)
        }
        return table
    }, [palette])

    useEffect(() => {
        const element = canvas.current
        if (!element || !width || !height) return
        const dpr = Math.min(2, globalThis.devicePixelRatio || 1)
        if (element.width !== Math.round(width * dpr) || element.height !== Math.round(height * dpr)) {
            element.width = Math.round(width * dpr)
            element.height = Math.round(height * dpr)
        }
        const ctx = element.getContext('2d')
        if (!ctx) return
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.clearRect(0, 0, width, height)

        const { cellWidth, gutterWidth, rowHeight } = geometry
        const gap = isLight ? '#cbd5e1' : '#475569'
        const ink = isLight ? '#94a3b8' : '#64748b'
        const every = gutterEvery(rowHeight)
        // Legible or absent. A label shrunk to fit a margin this narrow would be
        // a smear of half-digits, which reads as information and is not.
        ctx.font = `${Math.max(8, Math.min(11, rowHeight - 1))}px ${FONT_MONO}`
        ctx.textBaseline = 'middle'

        for (const entry of rows) {
            // The slab is positioned by the scroller; inside it a row sits at
            // its own offset from the first one drawn.
            const top = (entry.row - rows[0].row) * rowHeight + offsetPx
            if (top + rowHeight < 0 || top > height) continue

            if (entry.kind === 'header') {
                ctx.fillStyle = isLight ? '#334155' : '#cbd5e1'
                ctx.textAlign = 'left'
                ctx.fillText(
                    entry.section.record?.label || '',
                    gutterWidth + 2,
                    top + rowHeight / 2,
                )
                continue
            }

            const section = entry.section
            const line = displayRow(section.layout, entry.local)
            if (!line) continue
            const view = viewFor?.(section.key) || {}

            // The marks channel, only where something is being pointed at.
            // Everything else a row can carry -- a selection, the base a box is
            // open about -- needs elements to be worth drawing and has none.
            const previewing = Boolean(preview)

            for (const piece of line.pieces) {
                const range = { start: piece.s, end: piece.e }
                const codes = buildRowClasses({
                    row: range,
                    runs: view.runs || [],
                    cdsFrame: view.cdsFrame || [],
                    strand: view.strand || '+',
                    allowed: view.allowed || null,
                })
                const marks = previewing
                    ? geneEdgeMaskForRow(range, null, null, null, preview)
                    : ''
                // Reverse reading flips which end of the piece is drawn first;
                // the classes themselves are in forward genomic order either
                // way, as everywhere else in this subsystem.
                const reverse = Boolean(section.layout.reverse)
                // Neighbouring bases of one colour are filled as one rectangle,
                // and its edges are rounded to whole pixels. Sixty separate
                // fills at a fractional cell width do not tile: each one is a
                // shade narrower than its slot, and the background shows through
                // as a grid of hairlines over what should read as solid bands.
                // A run is also five to fifty times less drawing.
                let runColour = null
                let runDim = false
                let runFrom = 0
                const flush = (until) => {
                    if (!runColour || until <= runFrom) return
                    const left = Math.round(gutterWidth + (piece.at + runFrom) * cellWidth)
                    const right = Math.round(gutterWidth + (piece.at + until) * cellWidth)
                    ctx.globalAlpha = runDim ? DIMMED : 1
                    ctx.fillStyle = runColour
                    ctx.fillRect(left, top, Math.max(1, right - left), Math.max(1, rowHeight - 0.5))
                }
                for (let i = 0; i < piece.len; i += 1) {
                    const at = reverse ? piece.len - 1 - i : i
                    const code = codes[at] || CLASS_NONE
                    const colour = code === CLASS_NONE || code === CLASS_GAP
                        ? null
                        : (colours.get(code) || null)
                    const dim = previewing && !(parseInt(marks[at], 32) & EDGE_PREVIEW)
                    if (colour !== runColour || dim !== runDim) {
                        flush(i)
                        runColour = colour
                        runDim = dim
                        runFrom = i
                    }
                }
                flush(piece.len)
            }
            ctx.globalAlpha = 1

            // A collapsed stretch: a rule across the columns it stands for,
            // rather than the dashes and the count there is no room to print.
            for (const marker of line.marks) {
                ctx.fillStyle = gap
                ctx.fillRect(
                    gutterWidth + marker.at * cellWidth,
                    top + rowHeight / 2 - 0.5,
                    Math.max(1, marker.len * cellWidth),
                    1,
                )
            }

            // A coordinate down the margin, as often as there is room for one.
            if (line.firstCoord !== null && entry.row % every === 0) {
                const label = gutterLabel(line.firstCoord, gutterWidth)
                if (label) {
                    ctx.globalAlpha = previewing && !rowHasPreview(line, preview) ? DIMMED : 1
                    ctx.fillStyle = ink
                    ctx.textAlign = 'right'
                    ctx.fillText(label, gutterWidth - 3, top + rowHeight / 2)
                    ctx.globalAlpha = 1
                }
            }
        }
    }, [rows, viewFor, geometry, isLight, preview, width, height, offsetPx, colours, doc, model])

    return (
        <canvas
            ref={canvas}
            data-sequence-overview="true"
            style={{ width: `${width}px`, height: `${height}px`, display: 'block' }}
        />
    )
}

/** Whether any of a row belongs to the feature being pointed at. */
function rowHasPreview(line, preview) {
    if (!preview) return false
    return line.pieces.some((piece) => piece.e >= preview.s && piece.s <= preview.e)
}

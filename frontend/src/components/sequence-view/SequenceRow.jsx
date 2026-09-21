import { memo } from 'react'

import { FONT_MONO } from '../../utils/typography'
import { CLASS_GAP, CLASS_NONE } from '../../utils/sequenceViewPalette'
import { DEFAULT_PALETTE, textOnColour } from '../../utils/sequenceViewColours'
import { FEATURE_COLORS } from '../../utils/featureColors'
import { PLACEHOLDER_BASE } from '../../utils/sequenceViewChunks'
import {
    SELECT_BOTTOM,
    SELECT_LEFT,
    SELECT_NONE,
    SELECT_RIGHT,
    SELECT_TOP,
} from '../../utils/sequenceViewPaint'
import {
    EDGE_GENE_END,
    EDGE_GENE_START,
    EDGE_MARKED,
    EDGE_OVERLAP,
    EDGE_PREVIEW,
} from '../../utils/sequenceViewClasses'
import { GUTTER_WIDTH, PROTEIN_LANE_PX } from './sequenceViewLayout'

// Worked out once rather than per cell per repaint. The palette is a fixed
// table, so which of its colours want dark text is fixed too.
// The amber the Feature Explorer marks an exon junction with, reused here for a
// gene's edges so the two views mean the same thing by a vertical rule.
const BOUNDARY_COLOR = '#f59e0b'

// The selection and the ring on a base come from the palette, so a reader can
// colour them; their defaults and the reasons behind them are in
// utils/sequenceViewColours.js. Its wash and its outline are drawn at alphas
// held in custom properties, which is what lets them be a colour the reader
// picked at a weight this view chose. They used to be animated -- see the note
// in index.css for what that cost.

// The feature under the pointer in the list.
//
// A rule under the bases, closed at both ends of each run, rather than a wash
// over them. A tint has to compete with whatever the cells are already wearing,
// and at this size it loses: a third of a cyan over a mixed pink or a CDS blue
// is a shade of those colours, not a mark on them. It was a pulsing tint once,
// which solved the visibility by moving instead -- and cost seventeen per cent
// of the main thread to do it. A line does not have to compete: it is drawn at
// full strength on the one edge of the cell nothing else is using, and it reads
// from across the panel.
//
// The palette's own blue -- the one the exon and CDS fills are drawn in, and the
// one the genomic outline and the arrows use -- so pointing at a feature marks
// it in the colour the rest of the app already means "feature" by. It was a cyan
// once, picked to sit apart from every colour a base can wear; the cost was that
// it read as a colour of its own rather than as this view speaking. It still has
// to be told apart from the amber the annotation's own marks use, and it is:
// amber is the only other thing under a base, the two share the edge, and this
// one is there only while the pointer is.
const PREVIEW_LINE = FEATURE_COLORS.exon.bg
const PREVIEW_LINE_PX = 2
// The same rule turned up at the side of a row, in the margin between the
// coordinate and the first base. A row in the middle of a long feature carries
// an underline and nothing else, which is hard to pick out of a stack of rows
// at a glance; a mark at the end of the line says "this line too" from further
// away than a two-pixel rule under sixty letters does. Drawn only where the
// feature reaches the edge of the row -- a feature that begins mid-row is
// already marked precisely, at the border of its own first base, and a rail out
// at the margin would be a worse answer to the same question. Wider than the
// underline because it is a quarter of the length.
const PREVIEW_RAIL_PX = 3

// How much of a base is left showing when it is not part of what the pointer is
// on. Enough to see that sequence is still there and to read it if you look,
// little enough that the stretch being pointed at is the only thing the eye
// finds. The underline and the amber ends say exactly where it begins and ends;
// this is what says which of the forty rows on screen to look at in the first
// place.
const DIMMED = 0.22

// The protein, where the reader has asked for it. Quieter than a base, because
// it is a reading of the bases rather than a second annotation on them -- and a
// stop is called out, since it is the one letter whose position in the sequence
// is itself the thing worth seeing.
const AMINO_TEXT = { light: '#475569', dark: '#94a3b8' }
const AMINO_STOP = { light: '#b91c1c', dark: '#fca5a5' }

/**
 * One row of sequence: a coordinate, sixty cells, a coordinate.
 *
 * It listens for nothing. The pointer is handled once, on the scroller, because
 * a drag holds pointer capture there and a captured pointer retargets its
 * events -- so a handler on the row is simply not in the dispatch path while a
 * selection is being dragged. One handler for the whole slab is also thousands
 * fewer than one per cell.
 *
 * Memoised on its strings -- the bases, their classes, the selection mask, the
 * annotation's marks and the protein over them. A row's whole appearance is
 * those, so scrolling one row repaints one row rather than the whole slab, and
 * toggling a highlight repaints without anything moving.
 */
function SequenceRow({
    row,
    sequence,
    classes,
    mask,
    edges,
    amino = '',
    lane = false,
    labels,
    palette = DEFAULT_PALETTE,
    rowHeight,
    cellWidth,
    fontSize,
    // Wide enough for a nine-figure genomic coordinate by default, which is the
    // longest thing a gutter has to hold. A transcript read in its own
    // coordinates counts to about a hundred thousand and a protein to about
    // thirty, so those views pass a narrower one and spend the width on the
    // bases instead.
    gutterWidth = GUTTER_WIDTH,
    isLight,
    previewing = false,
    // Whether a finished selection is on the page at all. The mask says which
    // of this row's cells are in it; this says whether to dim the rest.
    selecting = false,
}) {
    // Whether there is a lane is the scroller's answer, not this row's: it is
    // what decided how tall the row is, and a row that drew one the height index
    // had not allowed for would draw it over its neighbour. So a row with the
    // space but no letters yet -- its bases still in flight -- holds an empty
    // lane rather than closing up and reflowing the document when they land.
    const laneHeight = lane ? PROTEIN_LANE_PX : 0
    const baseHeight = rowHeight - laneHeight
    const selectEdge = palette.selection.edge
    const markedRing = palette.ring(isLight)
    const gutter = isLight ? 'text-gray-400' : 'text-gray-500'
    const plainText = isLight ? '#334155' : '#cbd5e1'
    // Quieter than a base: the marker is a note about what is missing, not
    // something to read along.
    const gapText = isLight ? '#94a3b8' : '#64748b'

    // The marks channel, read once. It used to be parsed three times over --
    // once in the cell loop, once per protein letter and once more to ask
    // whether the row held any of the pointed-at feature at all.
    const marks = new Array(sequence.length)
    let previewedCells = 0
    for (let i = 0; i < sequence.length; i += 1) {
        const bits = edges ? (parseInt(edges[i], 32) || 0) : 0
        marks[i] = bits
        if (bits & EDGE_PREVIEW) previewedCells += 1
    }

    // What the row is attending to, and what it dims.
    //
    // Two things can ask for it: the feature under the pointer in the list, and
    // a finished selection. The pointer wins where both are true -- it is the
    // transient one, and answering it is the whole reason it is transient.
    //
    // A selection used to be a wash of colour laid over its bases, which is the
    // one thing that cannot be done to a view whose whole subject is what colour
    // a base is: every annotation under it came out a different shade of the
    // selection. It is the same dimming as the pointer's now, with the outline
    // left on to say where it begins and ends, and the bases inside it wearing
    // exactly the colours they wear everywhere else.
    let attended = 0
    if (previewing) attended = previewedCells
    else if (selecting) {
        for (let i = 0; i < mask.length; i += 1) if (mask[i] !== SELECT_NONE) attended += 1
    }
    const attending = previewing || selecting
    // Opacity on an element is a transparency layer the compositor has to keep,
    // and sixty cells a row over forty rows is two thousand of them -- which is
    // what turned scrolling with a gene held into a slideshow. Almost every row
    // is wholly in or wholly out, so almost every row can carry one opacity
    // instead of sixty; only the rows an end falls inside need deciding cell by
    // cell.
    const dimWholeRow = attending && attended === 0
    const dimSomeCells = attending && attended > 0 && attended < sequence.length

    const cells = []
    for (let i = 0; i < sequence.length; i += 1) {
        const base = sequence[i]
        const code = classes[i] || CLASS_NONE
        // A marker cell stands for sequence that is not on screen. It carries no
        // annotation, so it is drawn as text rather than as a coloured base.
        const isGap = code === CLASS_GAP
        // The dashes are drawn rather than typed. A hyphen centred in its own
        // cell leaves a space either side of it, so a row of them reads as
        // dots; the rule has to be continuous to read as one break in the
        // sequence. The label's own characters stay as text, and the spaces
        // around it leave the gap in the rule that makes it readable.
        //
        // The hyphen is still rendered, in transparent ink. An inline-block with
        // no content at all has no line box and so collapses to zero height --
        // which paints no rule, and leaves a cell the pointer cannot land on.
        const isRule = isGap && base === '-'
        const style = code === CLASS_NONE || isGap ? null : palette.style(code)
        // Outlined rather than filled: the class marks this base as sequence of
        // a kind rather than as the feature itself, and an outline says that at
        // a glance where another shade of the same hue would not.
        //
        // Drawn as one band over the whole run rather than a box per base. A box
        // per base reads as beads on a string, and the thing being marked is a
        // stretch of sequence, not sixty separate ones -- so the rule runs along
        // the top and bottom throughout and closes only at the ends, which a row
        // edge counts as.
        const outlined = Boolean(style?.outline)
        const opensLeft = outlined && classes[i - 1] === code
        const opensRight = outlined && classes[i + 1] === code
        const selected = mask[i] !== SELECT_NONE
        const sides = selected ? parseInt(mask[i], 16) : 0
        // The marks channel: where a gene begins or ends, and where more than
        // one gene covers the base. Read as bits because a base can carry both.
        const edge = marks[i]
        const pending = base === PLACEHOLDER_BASE
        // Where the pointed-at run starts and stops inside this row. Read off
        // the neighbours rather than from a mask of its own: a feature covers a
        // contiguous stretch, so its ends are wherever the next cell along is
        // not part of it, which is one character either side.
        //
        // The end of a *row* is not the end of the run -- the feature carries on
        // over the edge and onto the next line. Capping there would close a box
        // around every line of it, which reads as a series of stretches rather
        // than one, and would sit on top of the amber marks the feature's real
        // first and last base already carry.
        const previewed = Boolean(edge & EDGE_PREVIEW)
        const previewAt = (at) => Boolean(marks[at] & EDGE_PREVIEW)
        const opensPreviewLeft = previewed && (i === 0 || previewAt(i - 1))
        const opensPreviewRight = previewed && (i === sequence.length - 1 || previewAt(i + 1))
        // Where the run leaves the row rather than stopping in it. Those are
        // exactly the two positions the caps above cannot speak for: the run
        // carries on past the edge, so there is nothing to close, and the rail
        // goes outside the cell instead.
        const railLeft = previewed && i === 0
        const railRight = previewed && i === sequence.length - 1
        // A marker cell stands for sequence that is not on screen, so it belongs
        // to no feature and dims with everything else.
        const dimmed = dimSomeCells && !(previewing ? previewed : selected)

        cells.push(
            <span
                key={i}
                data-offset={i}
                className="inline-block text-center select-none"
                data-preview={edge & EDGE_PREVIEW ? '1' : undefined}
                style={{
                    width: `${cellWidth}px`,
                    lineHeight: `${baseHeight - 6}px`,
                    // Everything about the cell at once -- its fill, its letter,
                    // its outline and any rule under it -- rather than a paler
                    // version of each, which would have meant a second colour
                    // for every class and a second rule for every mark.
                    ...(dimmed ? { opacity: DIMMED } : null),
                    backgroundColor: style && !outlined ? style.bg : 'transparent',
                    color: isRule ? 'transparent'
                        : pending ? (isLight ? '#cbd5e1' : '#475569')
                        : isGap ? gapText
                        // An outlined cell has no fill for a letter to sit on,
                        // so the letter stays the colour an unmarked base is.
                        : style && !outlined ? textOnColour(style.bg) : plainText,
                    ...(isRule ? {
                        backgroundImage: `linear-gradient(${gapText}, ${gapText})`,
                        backgroundSize: '100% 1px',
                        backgroundPosition: 'center',
                        backgroundRepeat: 'no-repeat',
                    } : null),
                    // Earlier shadows paint over later ones, so the selection's
                    // own edge sits above the class outline, and the wash that
                    // tints the whole cell goes last of all. One list rather
                    // than one property per mark, because a second boxShadow
                    // would replace the first rather than adding to it.
                    ...(outlined || selected || previewed ? {
                        boxShadow: [
                            // The rails, outside the cell rather than inset:
                            // an offset shadow with no blur is the cell's own
                            // rectangle shifted into the margin, so the mark
                            // lines up with the underline to the pixel and
                            // costs the row no width. Every row here is exactly
                            // sixty cells wide, and the gutter's padding is
                            // where these sit.
                            railLeft ? `-${PREVIEW_RAIL_PX}px 0 0 0 ${PREVIEW_LINE}` : '',
                            railRight ? `${PREVIEW_RAIL_PX}px 0 0 0 ${PREVIEW_LINE}` : '',
                            // The feature being pointed at: under every base of
                            // it, and closed at the ends of the run so the mark
                            // has a start and a stop rather than trailing off.
                            // A shadow rather than a border, so it costs the
                            // cell none of its width -- every row here is
                            // exactly sixty cells wide.
                            previewed ? `inset 0 -${PREVIEW_LINE_PX}px 0 0 ${PREVIEW_LINE}` : '',
                            previewed && !opensPreviewLeft ? `inset ${PREVIEW_LINE_PX}px 0 0 0 ${PREVIEW_LINE}` : '',
                            previewed && !opensPreviewRight ? `inset -${PREVIEW_LINE_PX}px 0 0 0 ${PREVIEW_LINE}` : '',
                            selected && (sides & SELECT_TOP) ? `inset 0 1.5px 0 0 ${selectEdge}` : '',
                            selected && (sides & SELECT_BOTTOM) ? `inset 0 -1.5px 0 0 ${selectEdge}` : '',
                            selected && (sides & SELECT_LEFT) ? `inset 1.5px 0 0 0 ${selectEdge}` : '',
                            selected && (sides & SELECT_RIGHT) ? `inset -1.5px 0 0 0 ${selectEdge}` : '',
                            outlined ? `inset 0 1px 0 0 ${style.bg}` : '',
                            outlined ? `inset 0 -1px 0 0 ${style.bg}` : '',
                            outlined && !opensLeft ? `inset 1px 0 0 0 ${style.bg}` : '',
                            outlined && !opensRight ? `inset -1px 0 0 0 ${style.bg}` : '',
                        ].filter(Boolean).join(', '),
                    } : null),
                    // Outermost of the inset rules, so the base being asked
                    // about is ringed whatever else is drawn on it.
                    ...(edge & EDGE_MARKED ? {
                        // Drawn wholly inside the cell. At any smaller inset the
                        // ring's outer pixel lies over the neighbouring cell,
                        // and the cell to the right -- a later sibling, so
                        // painted afterwards -- covers that side of it, which
                        // made the ring look thinner on one side than the other.
                        outline: `2px solid ${markedRing}`,
                        outlineOffset: '-2px',
                    } : null),
                    ...(edge & EDGE_GENE_START ? { borderLeft: `2.5px solid ${BOUNDARY_COLOR}` } : null),
                    ...(edge & EDGE_GENE_END ? { borderRight: `2.5px solid ${BOUNDARY_COLOR}` } : null),
                    // Drawn as a background layer rather than a border so that
                    // it sits over the fill without taking a pixel of the
                    // cell's width -- every row here is exactly sixty cells
                    // wide, and a rule that changed that would shift the text
                    // under it. It runs unbroken across neighbouring cells,
                    // which is what makes a shared stretch read as one stretch.
                    ...(edge & EDGE_OVERLAP && !isGap ? {
                        backgroundImage: `linear-gradient(${palette.overlap}, ${palette.overlap})`,
                        backgroundSize: '100% 2px',
                        backgroundPosition: 'bottom',
                        backgroundRepeat: 'repeat-x',
                    } : null),
                }}
            >
                {base}
            </span>,
        )
    }

    // One span per cell here too, rather than one string across the row: the
    // letters have to stay in the columns their codons are in, and a centred
    // string would drift the moment a row held a gap marker or ran short.
    const aminoCells = []
    for (let i = 0; lane && i < sequence.length; i += 1) {
        const letter = amino[i] || ' '
        const dimmed = dimSomeCells
            && !(previewing ? (marks[i] & EDGE_PREVIEW) : mask[i] !== SELECT_NONE)
        aminoCells.push(
            <span
                key={i}
                className="inline-block text-center select-none"
                style={{
                    width: `${cellWidth}px`,
                    lineHeight: `${PROTEIN_LANE_PX}px`,
                    color: letter === '*'
                        ? (isLight ? AMINO_STOP.light : AMINO_STOP.dark)
                        : (isLight ? AMINO_TEXT.light : AMINO_TEXT.dark),
                    fontWeight: letter === '*' ? 700 : 500,
                    ...(dimmed ? { opacity: DIMMED } : null),
                }}
            >
                {letter === ' ' ? '\u00a0' : letter}
            </span>,
        )
    }

    return (
        <div
            className="flex items-center"
            // A row with none of the pointed-at feature in it dims whole,
            // coordinates and all -- which is what turns "these bases" into
            // "this part of the page", and costs one layer rather than sixty.
            style={{
                height: `${rowHeight}px`,
                fontFamily: FONT_MONO,
                fontSize: `${fontSize}px`,
                ...(dimWholeRow ? { opacity: DIMMED } : null),
            }}
            data-row-index={row.index}
            data-row-start={row.firstCoord ?? ''}
            data-row-end={row.lastCoord ?? ''}
        >
            <span
                className={`text-right tabular-nums text-[11px] pr-3 ${gutter}`}
                style={{ width: `${gutterWidth}px` }}
            >
                {Number.isFinite(labels.left) ? labels.left.toLocaleString() : ''}
            </span>
            <span className="whitespace-nowrap">
                {laneHeight ? (
                    <span className="block whitespace-nowrap" style={{ height: `${PROTEIN_LANE_PX}px` }}>
                        {aminoCells}
                    </span>
                ) : null}
                <span className="block whitespace-nowrap" style={{ height: `${baseHeight}px` }}>{cells}</span>
            </span>
            <span
                className={`text-left tabular-nums text-[11px] pl-3 ${gutter}`}
                style={{ width: `${gutterWidth}px` }}
            >
                {Number.isFinite(labels.right) ? labels.right.toLocaleString() : ''}
            </span>
        </div>
    )
}

export default memo(SequenceRow, (before, after) => (
    before.sequence === after.sequence
    && before.classes === after.classes
    && before.mask === after.mask
    && before.edges === after.edges
    && before.amino === after.amino
    && before.lane === after.lane
    && before.palette === after.palette
    && before.rowHeight === after.rowHeight
    && before.cellWidth === after.cellWidth
    && before.fontSize === after.fontSize
    && before.gutterWidth === after.gutterWidth
    && before.isLight === after.isLight
    // Not one of the row's own strings, but a row with none of the pointed-at
    // feature in it has to repaint when one appears elsewhere -- that is the
    // whole of what dimming is. Left out, only the rows that already contained
    // the feature ever dimmed, which is precisely the rows that should not.
    && before.previewing === after.previewing
    && before.selecting === after.selecting
    && before.row.index === after.row.index
    && before.labels.left === after.labels.left
    && before.labels.right === after.labels.right
))

import { memo, useMemo } from 'react'

import { FONT_MONO } from '../../utils/typography'
import { CLASS_CODES, CLASS_GAP } from '../../utils/sequenceViewPalette'
import { findLane } from '../../utils/sequenceViewPaint'
import { textOnColour } from '../../utils/sequenceViewColours'
import {
    DISPLAY_TEXT,
    displayDropsGaps,
    displayHasGutters,
    gutterText,
    plainInk,
    plainLineChars,
    plainRuns,
    sectionHeaderLine,
} from '../../utils/sequenceViewPlain'

/**
 * The rows the scroller has mounted, written into one block of text.
 *
 * One `<pre>`, not one element per row. That is the whole trick: a browser
 * selects, copies and finds across text nodes in document order, and a stack of
 * absolutely positioned rows is not that -- a drag across it would select in
 * whatever order the boxes happen to lie, and a copy would come back with the
 * gutters run together. Inside a single `<pre>` the characters are in reading
 * order, so `Ctrl-C` gives back exactly what the rows show and `Ctrl-F` searches
 * the lines as lines.
 *
 * Every row is one line, and the line box is exactly as tall as the row the
 * scroll model allotted it. The plain displays draw no protein lane, so every
 * row is the same height and the model is one multiply again.
 *
 * Colour is the letters' own ink. A fill behind each base would be the
 * interactive display drawn a second, worse way -- sixty elements a row, in a
 * mode chosen for not having them -- and it would put a box around the very
 * characters the reader is trying to select. Neighbouring bases of one class are
 * one span, so a screen of intronic sequence costs one element rather than
 * twenty-four hundred.
 */
function SequencePlainText({
    items,
    display = DISPLAY_TEXT,
    colour = true,
    palette,
    isLight,
    chrom = '',
    unnamed = '',
    // The colours the find channel's lanes name. See sequenceViewPaint.js.
    findColours = null,
    fontSize,
    rowHeight,
}) {
    const gutters = displayHasGutters(display)
    const dropGaps = displayDropsGaps(display)
    // In characters, not in pixels: the block is exactly as wide as its own
    // longest line in whatever font actually rendered, and `margin: 0 auto`
    // then centres it in the panel the way the rows are centred in the
    // interactive display. Sized in pixels from an assumed advance it would sit
    // off-centre by however much that assumption was wrong.
    const chars = plainLineChars(display)

    // One ink per class for the whole screen rather than one per run: a screen
    // can hold the same class a hundred times, and working the contrast out per
    // run would do the same arithmetic over and over. There are seventeen
    // classes in the whole palette, so the table is built at once rather than
    // filled in as classes turn up -- a cache that has to be mutated while the
    // rows are being drawn is a cache nothing can memoise safely.
    const inks = useMemo(() => {
        const out = {}
        if (!colour) return out
        for (const code of Object.values(CLASS_CODES)) {
            const style = palette?.style?.(code)
            const ink = style?.bg ? plainInk(style.bg, isLight) : null
            if (ink) out[code] = ink
        }
        return out
    }, [colour, palette, isLight])

    const plain = isLight ? '#334155' : '#cbd5e1'
    // A marker stands for sequence that is not on the screen, and a coordinate
    // is a note in the margin: both are quieter than a base, because neither is
    // something to read along.
    const quiet = isLight ? '#94a3b8' : '#64748b'

    return (
        <pre
            className="m-0 whitespace-pre"
            data-sequence-plain={display}
            style={{
                fontFamily: FONT_MONO,
                fontSize: `${fontSize}px`,
                lineHeight: `${rowHeight}px`,
                width: `${chars}ch`,
                margin: '0 auto',
                color: plain,
                // The one thing this display exists for. The scroller turns it
                // off while the Select tool is armed, which the plain displays
                // never are.
                userSelect: 'text',
                WebkitUserSelect: 'text',
            }}
        >
            {items.map((item) => {
                if (item.kind === 'header') {
                    // A record's name, written as the header line of its own
                    // FASTA record -- in both plain displays, so that a copied
                    // collection is one parseable thing rather than two.
                    return (
                        <span key={item.key} style={{ color: quiet, fontWeight: 600 }}>
                            {sectionHeaderLine(item.section, chrom, unnamed)}
                            {'\n'}
                        </span>
                    )
                }
                // A match is drawn as a fill here, where the interactive
                // display draws a bar under the bases. The bar exists there
                // because a wash fights the cell's annotation colour; in text
                // there is no fill to fight, and a found word on a coloured
                // ground is what every reader already knows a find to look
                // like. The class ink survives underneath it either way.
                const runs = plainRuns(item.sequence, item.classes, {
                    colour,
                    dropGaps,
                    finds: findColours?.length ? item.finds : '',
                })
                return (
                    <span key={item.key} data-plain-row={item.row}>
                        {gutters ? (
                            <span style={{ color: quiet }}>{gutterText(item.line.firstCoord)}{'  '}</span>
                        ) : null}
                        {runs.map((run, at) => {
                            const lane = findLane(run.lane)
                            const fill = lane >= 0 ? findColours?.[lane] : null
                            if (fill) {
                                return (
                                    <span key={at} style={{ background: fill, color: textOnColour(fill) }}>
                                        {run.text}
                                    </span>
                                )
                            }
                            // A marker is quiet rather than coloured: it is a
                            // note about sequence that is not here, and there is
                            // no class of base under it to have a colour.
                            const ink = run.code === CLASS_GAP ? quiet : inks[run.code]
                            return ink
                                ? <span key={at} style={{ color: ink }}>{run.text}</span>
                                : <span key={at}>{run.text}</span>
                        })}
                        {gutters ? (
                            <span style={{ color: quiet }}>{'  '}{gutterText(item.line.lastCoord)}</span>
                        ) : null}
                        {'\n'}
                    </span>
                )
            })}
        </pre>
    )
}

export default memo(SequencePlainText)

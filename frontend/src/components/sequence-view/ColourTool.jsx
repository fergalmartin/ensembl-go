import { useCallback, useId, useRef, useState } from 'react'

import { menuPosition, useMenuDismiss } from '../alignment-explorer/menuAnchor'
import { ControlChevron, ControlMenu } from './ControlChrome'
import GenomeColorPicker from '../GenomeColorPicker'
import { FONT_MONO } from '../../utils/typography'
import {
    COLOUR_SECTIONS,
    DEFAULT_COLOURS,
    FOLLOW_THEME,
    RING_THEME,
    buildPalette,
    codonPartner,
    collisionsIn,
    coloursChanged,
} from '../../utils/sequenceViewColours'

const MENU_WIDTH = 360

/** A run of bases as the sequence would draw them, for one item's colour.
 *
 * The preview the colour picker shows instead of its gene track. A colour here
 * is chosen for how a stretch of annotated bases reads, which is not the same
 * question as how a gene model reads -- the cells are small, they carry letters
 * over them, and half of these classes are an outline rather than a fill.
 */
function BasesPreview({ item, colour, isLight }) {
    const bases = 'ATGCTAGGCATCGATCAGT'.split('')
    const second = item.striped ? codonPartner(colour) : colour
    const outlined = item.kind === 'outline'
    const underlined = item.kind === 'underline'
    // A highlight is not a colour a base wears but a mark over whatever it is
    // already wearing, so it previews over ordinary sequence rather than as a
    // run of coloured cells. The middle of the run is marked, so a reader can
    // see the mark against bases on both sides -- which is where it has to work.
    const selected = item.kind === 'selection'
    const ringed = item.kind === 'ring'
    const marks = selected || ringed
    const from = 5
    const to = selected ? 13 : 5
    const text = isLight ? '#334155' : '#cbd5e1'
    return (
        <div
            className={`rounded-xl border overflow-hidden ${isLight ? 'border-gray-200 bg-white' : 'border-gray-700 bg-[#1E2938]'}`}
        >
            <div className="flex justify-center px-3 py-4" style={{ fontFamily: FONT_MONO, fontSize: 13 }}>
                {bases.map((base, index) => {
                    // Two shades alternating by codon where the class stripes,
                    // so the preview shows the frame the way the rows do.
                    const fill = item.striped ? (Math.floor(index / 3) % 2 ? second : colour) : colour
                    const marked = marks && index >= from && index <= to
                    return (
                        <span
                            key={index}
                            className="inline-block text-center"
                            style={{
                                width: 15,
                                lineHeight: '22px',
                                color: marks || outlined || underlined ? text : contrastText(fill),
                                backgroundColor: marks || outlined || underlined ? 'transparent' : fill,
                                boxShadow: outlined
                                    ? `inset 0 1px 0 0 ${colour}, inset 0 -1px 0 0 ${colour}${index === 0 ? `, inset 1px 0 0 0 ${colour}` : ''}${index === bases.length - 1 ? `, inset -1px 0 0 0 ${colour}` : ''}`
                                    : selected && marked
                                        ? [
                                            `inset 0 1.5px 0 0 ${colour}`,
                                            `inset 0 -1.5px 0 0 ${colour}`,
                                            index === from ? `inset 1.5px 0 0 0 ${colour}` : '',
                                            index === to ? `inset -1.5px 0 0 0 ${colour}` : '',
                                            `inset 0 0 0 100px ${colour}59`,
                                        ].filter(Boolean).join(', ')
                                        : 'none',
                                ...(ringed && marked ? {
                                    outline: `2px solid ${colour}`,
                                    outlineOffset: '-2px',
                                } : null),
                                ...(underlined ? {
                                    backgroundImage: `linear-gradient(${colour}, ${colour})`,
                                    backgroundSize: '100% 2px',
                                    backgroundPosition: 'bottom',
                                    backgroundRepeat: 'repeat-x',
                                } : null),
                            }}
                        >
                            {base}
                        </span>
                    )
                })}
            </div>
            <div className={`px-3 py-1.5 text-[10px] border-t ${isLight ? 'border-gray-100 text-gray-500' : 'border-gray-700/60 text-gray-400'}`}>
                {item.label}
                {outlined ? ' · outlined, because it is not the feature itself' : ''}
                {item.striped ? ' · the second shade follows the first' : ''}
                {selected ? ' · a wash over the cells and a line around the whole of them' : ''}
                {ringed ? ' · drawn inside the cell, over whatever the base is wearing' : ''}
            </div>
        </div>
    )
}

/** Dark text on a light colour and light text on a dark one, the way a cell
 * decides it. Kept simple here: the preview is a sample, not the row. */
function contrastText(hex) {
    const clean = String(hex || '').replace('#', '')
    if (clean.length !== 6) return '#ffffff'
    const [red, green, blue] = [0, 2, 4].map((at) => parseInt(clean.slice(at, at + 2), 16))
    return (red * 0.299 + green * 0.587 + blue * 0.114) > 150 ? '#0f172a' : '#ffffff'
}

/** The sample beside an item's name in the menu. */
function ItemSwatch({ item, colour }) {
    if (item.kind === 'ring') {
        return <span className="sv-swatch" style={{ background: 'transparent', boxShadow: `inset 0 0 0 2px ${colour}` }} />
    }
    if (item.kind === 'selection') {
        return <span className="sv-swatch" style={{ background: `${colour}59`, borderColor: colour }} />
    }
    if (item.kind === 'underline') {
        return <span className="sv-swatch" style={{ background: 'transparent', borderBottom: `3px solid ${colour}` }} />
    }
    if (item.kind === 'outline') {
        return <span className="sv-swatch" style={{ background: 'transparent', border: `2px solid ${colour}` }} />
    }
    if (item.striped) {
        return (
            <span
                className="sv-swatch"
                style={{ background: `linear-gradient(90deg, ${colour} 50%, ${codonPartner(colour)} 50%)`, borderColor: colour }}
            />
        )
    }
    return <span className="sv-swatch" style={{ background: colour, borderColor: colour }} />
}

/**
 * What every kind of annotation is drawn in.
 *
 * Grouped by what is on screen together rather than by class: a location and a
 * gene are the same vocabulary at two scales, and a transcript, an exon and an
 * intron are the same as each other. The two kinds that appear in both are
 * listed once, in their own group -- listing them twice with one value behind
 * them reads as a bug the moment a reader changes one and the other moves.
 *
 * Highlighting is its own group for a different reason: a selection and the ring
 * on a base are marks about what the *reader* is doing rather than about the
 * sequence, they are drawn over whatever colour a base already wears, and they
 * are the same at every level. The ring follows the theme until somebody picks
 * a colour for it, because high contrast against the page is the whole of its
 * job; choosing one is trading that for a colour of their own.
 *
 * Picking a colour opens the app's own colour dialog, the one the genome
 * selector uses, with a preview of annotated bases in place of its gene track.
 * A colour here is chosen for how a run of small lettered cells reads, which is
 * a different question from how a gene model reads.
 *
 * Applied as it is picked rather than gathered behind an Apply. Nothing is
 * fetched and no layout changes -- a colour is one more thing the already-drawn
 * rows are painted with -- and a colour is judged against the sequence, so
 * making the reader confirm it before they can see it on their own screen would
 * be asking them to choose blind.
 */
export default function ColourTool({
    colours = DEFAULT_COLOURS,
    palette,
    theme = 'dark',
    root = null,
    onChange,
    onReset,
    disabled = false,
}) {
    const [anchor, setAnchor] = useState(null)
    const [editing, setEditing] = useState(null)
    const button = useRef(null)
    const menuId = useId()
    const isLight = theme === 'light'

    const close = useCallback(() => setAnchor(null), [])
    // The picker is a modal over everything, so a press inside it must not read
    // as a press away from the menu that opened it.
    useMenuDismiss(Boolean(anchor) && !editing, close, button, 'sv-menu')

    const open = () => {
        if (anchor) { close(); return }
        setAnchor(menuPosition(button.current, MENU_WIDTH, 'sv'))
    }

    const shown = palette || buildPalette(colours)

    /** What an item is actually drawn in, which for a themed item is whatever
     * the theme resolves it to while it is still following one. */
    const colourOf = (item) => (item.themed && shown.colours[item.key] === FOLLOW_THEME
        ? RING_THEME[isLight ? 'light' : 'dark']
        : shown.colours[item.key])

    /** What the row prints on the right: a hex, or the word for following. */
    const valueOf = (item) => (item.themed && shown.colours[item.key] === FOLLOW_THEME
        ? 'Theme'
        : shown.colours[item.key])

    // Picking the theme's own colour for a themed item puts it back to
    // following the theme rather than pinning today's answer -- which is what
    // "Use default" in the dialog means there, and what a reader who picked the
    // colour it already shows almost certainly meant too.
    const apply = (item, colour) => onChange?.(
        item.key,
        item.themed && colour.toLowerCase() === RING_THEME[isLight ? 'light' : 'dark'].toLowerCase()
            ? FOLLOW_THEME
            : colour,
    )

    return (
        <>
            <button
                ref={button}
                type="button"
                className={`sv-control sv-control-colour ${anchor ? 'menu-open' : ''}`}
                disabled={disabled}
                aria-label="Colours"
                aria-haspopup="dialog"
                aria-expanded={Boolean(anchor)}
                aria-controls={anchor ? menuId : undefined}
                title="What each kind of annotation is drawn in"
                onClick={open}
            >
                <span className="sv-control-name">Colour</span>
                <ControlChevron />
            </button>

            <ControlMenu id={menuId} root={root} anchor={anchor} title="Colour" className="sv-colour-menu">
                {COLOUR_SECTIONS.map((section) => {
                    const clashes = collisionsIn(section.key, shown.colours)
                    return (
                        <div key={section.key} className="sv-menu-section">
                            <span className="sv-menu-title">{section.label}</span>
                            {section.items.map((item) => (
                                <button
                                    key={item.key}
                                    type="button"
                                    className="sv-colour-row"
                                    onClick={() => setEditing(item)}
                                    title={`Change the colour of ${item.label}`}
                                >
                                    <ItemSwatch item={item} colour={colourOf(item)} />
                                    <span className="sv-colour-name">
                                        {item.label}
                                        {clashes.has(item.key) ? (
                                            // Not forbidden, but worth saying: two
                                            // annotations drawn the same way cannot be
                                            // told apart, whatever the legend claims.
                                            <small>Same as {clashes.get(item.key)}</small>
                                        ) : item.hint ? <small>{item.hint}</small> : null}
                                    </span>
                                    <span className="sv-colour-value">{valueOf(item)}</span>
                                </button>
                            ))}
                        </div>
                    )
                })}
                <div className="sv-menu-actions">
                    <small>Each change is applied as you make it.</small>
                    <button type="button" onClick={onReset} disabled={!coloursChanged(shown.colours)}>
                        Reset all
                    </button>
                    <button type="button" onClick={close}>Close</button>
                </div>
            </ControlMenu>

            <GenomeColorPicker
                isOpen={Boolean(editing)}
                theme={theme}
                title={editing ? `${editing.label} colour` : ''}
                subtitle={editing?.hint || 'Shown wherever this annotation is drawn.'}
                currentColor={editing ? colourOf(editing) : ''}
                defaultColor={editing
                    ? (editing.themed ? RING_THEME[isLight ? 'light' : 'dark'] : DEFAULT_COLOURS[editing.key])
                    : ''}
                renderPreview={(colour) => (
                    <BasesPreview item={editing} colour={colour} isLight={isLight} />
                )}
                paletteHint="The same palette the genome colours come from. Mix your own for anything else."
                onApply={(colour) => apply(editing, colour)}
                onClose={() => setEditing(null)}
            />
        </>
    )
}

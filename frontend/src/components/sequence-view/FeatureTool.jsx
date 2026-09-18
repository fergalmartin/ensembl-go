import { useCallback, useId, useRef, useState } from 'react'

import { menuPosition, useMenuDismiss } from '../alignment-explorer/menuAnchor'
import { ControlChevron, ControlMenu } from './ControlChrome'
import { COLLAPSE_KINDS, DEFAULT_COLLAPSE } from '../../utils/sequenceViewDisplay'
import {
    DEFAULT_FLANKS,
    FLANK_LEVELS,
    LEVEL_FEATURE,
    LEVEL_GENE,
    LEVEL_TRANSCRIPT,
    flankPair,
} from '../../utils/sequenceViewFocus'

const MENU_WIDTH = 420

// No gloss on the labels. "Intergenic" and "intronic" are not words this menu
// has to teach anybody reading sequence, and a line under each switch saying
// what it plainly says is a line between the switch and the fields it governs.
const COLLAPSE_COPY = {
    intergenic: { label: 'Collapse intergenic' },
    intron: { label: 'Collapse intronic' },
}

const FLANK_COPY = {
    [LEVEL_GENE]: 'Gene',
    [LEVEL_TRANSCRIPT]: 'Transcript',
    [LEVEL_FEATURE]: 'Exon or intron',
}

/** Digits only, and kept as text while it is being typed: a field that coerces
 * on every keystroke cannot be emptied to type a different number into. */
const digits = (value) => String(value ?? '').replace(/[^0-9]/g, '')

/** Why a kind cannot be collapsed here, said only where the answer said why.
 *
 * Never inferred from a kind simply being absent. That inference is how a
 * twelve-gene region came to be told there were too many genes in it: the
 * sentence was reached by an answer the client could not read, not by a count. */
function unavailable(limited) {
    return limited === 'gene_count'
        ? 'Not here: too many genes to read every isoform.'
        : 'Not available here.'
}

function number(value, fallback) {
    const parsed = Number(digits(value))
    return Number.isFinite(parsed) && String(value ?? '') !== '' ? parsed : fallback
}

/**
 * Everything about how a feature is read, in one menu.
 *
 * The four questions here are different, but they are all the same *kind* of
 * question -- what the rows show of the thing in focus, rather than what is in
 * focus, which the drawer owns. Splitting them across four buttons would have
 * put four narrow controls on the bar, each reading as a mode; gathering them
 * loses nothing, because a reader changing one of them is usually changing two.
 *
 * Menu edits are a draft, published by Apply, the way the explorer's Colour and
 * Gaps menus work. Every one of these settings costs something -- a new window
 * to fetch, a new layout to place every row in, a translation over every codon
 * on screen -- so applying them one keystroke at a time would refetch and
 * re-lay-out the view while the reader was still typing the number.
 */
export default function FeatureTool({
    collapse = DEFAULT_COLLAPSE,
    flanks = DEFAULT_FLANKS,
    reverse = false,
    protein = false,
    // Whether the rows on screen have a reading frame to translate, and which
    // way they are being read at the moment. Both are facts about the view, so
    // the menu reports them rather than asking the reader to work them out.
    proteinAvailable = true,
    readingReverse = false,
    offers = COLLAPSE_KINDS,
    limited = '',
    root = null,
    onApply,
    disabled = false,
}) {
    const [anchor, setAnchor] = useState(null)
    const [draft, setDraft] = useState(null)
    const button = useRef(null)
    const menuId = useId()

    const close = useCallback(() => { setAnchor(null); setDraft(null) }, [])
    useMenuDismiss(Boolean(anchor), close, button, 'sv-menu')

    const open = () => {
        if (anchor) { close(); return }
        setDraft({
            collapse: Object.fromEntries(COLLAPSE_KINDS.map((kind) => [kind, {
                on: Boolean(collapse?.[kind]?.on),
                flank: String(collapse?.[kind]?.flank ?? DEFAULT_COLLAPSE[kind].flank),
                min: String(collapse?.[kind]?.min ?? DEFAULT_COLLAPSE[kind].min),
            }])),
            flanks: Object.fromEntries(FLANK_LEVELS.map((level) => {
                const pair = flankPair(flanks?.[level], DEFAULT_FLANKS[level])
                return [level, { five: String(pair.five), three: String(pair.three) }]
            })),
            reverse: Boolean(reverse),
            protein: Boolean(protein),
        })
        setAnchor(menuPosition(button.current, MENU_WIDTH, 'sv'))
    }

    const editCollapse = (kind, patch) => setDraft((current) => ({
        ...current,
        collapse: { ...current.collapse, [kind]: { ...current.collapse[kind], ...patch } },
    }))
    const editFlank = (level, end, value) => setDraft((current) => ({
        ...current,
        flanks: { ...current.flanks, [level]: { ...current.flanks[level], [end]: digits(value) } },
    }))

    const publish = () => {
        onApply({
            collapse: Object.fromEntries(COLLAPSE_KINDS.map((kind) => [kind, {
                on: Boolean(draft.collapse[kind].on),
                flank: number(draft.collapse[kind].flank, DEFAULT_COLLAPSE[kind].flank),
                // A floor of zero would collapse every gap there is, including
                // the ones a marker is longer than, so one is the least it can be.
                min: Math.max(1, number(draft.collapse[kind].min, DEFAULT_COLLAPSE[kind].min)),
            }])),
            flanks: Object.fromEntries(FLANK_LEVELS.map((level) => [level, {
                five: number(draft.flanks[level].five, DEFAULT_FLANKS[level].five),
                three: number(draft.flanks[level].three, DEFAULT_FLANKS[level].three),
            }])),
            reverse: Boolean(draft.reverse),
            protein: Boolean(draft.protein),
        })
        close()
    }

    return (
        <>
            {/* The name and the mark, and no third thing. A value line under the
                name is how the explorer's controls read, and it earns its place
                where the value is one word that changes what the canvas means.
                Here it was a list of four switches abbreviated to fit, which is
                a worse version of the menu that is one click away. */}
            <button
                ref={button}
                type="button"
                className={`sv-control sv-control-feature ${anchor ? 'menu-open' : ''}`}
                disabled={disabled}
                aria-label="Features"
                aria-haspopup="dialog"
                aria-expanded={Boolean(anchor)}
                aria-controls={anchor ? menuId : undefined}
                title="How the sequence is read"
                onClick={open}
            >
                <span className="sv-control-name">Features</span>
                <ControlChevron />
            </button>

            {draft ? (
                <ControlMenu id={menuId} root={root} anchor={anchor} title="Features">
                    <div className="sv-menu-section">
                        <span className="sv-menu-title">What to leave out</span>
                        {COLLAPSE_KINDS.map((kind) => {
                            const choice = draft.collapse[kind]
                            const available = offers.includes(kind)
                            return (
                                <div key={kind} className="sv-menu-item">
                                    <label className="sv-menu-check">
                                        <input
                                            type="checkbox"
                                            checked={choice.on}
                                            onChange={(event) => editCollapse(kind, { on: event.target.checked })}
                                        />
                                        {COLLAPSE_COPY[kind].label}
                                    </label>
                                    <fieldset
                                        className="sv-menu-fields"
                                        disabled={!choice.on}
                                        aria-label={`${COLLAPSE_COPY[kind].label} settings`}
                                    >
                                        <label>
                                            Keep either side
                                            <input
                                                type="text"
                                                inputMode="numeric"
                                                maxLength="6"
                                                value={choice.flank}
                                                aria-label={`Bases to keep at each end of a collapsed ${kind} stretch`}
                                                onChange={(event) => editCollapse(kind, { flank: digits(event.target.value) })}
                                            />
                                            bp
                                        </label>
                                        <label>
                                            Smallest to collapse
                                            <input
                                                type="text"
                                                inputMode="numeric"
                                                maxLength="8"
                                                value={choice.min}
                                                aria-label={`Shortest ${kind} stretch worth collapsing`}
                                                onChange={(event) => editCollapse(kind, { min: digits(event.target.value) })}
                                            />
                                            bp
                                        </label>
                                    </fieldset>
                                    {/* Only where there is something to say, and
                                        outside the fieldset, which greys what it
                                        holds -- a reader who cannot use the switch
                                        is exactly the one who needs to read why. */}
                                    {available ? null : (
                                        <small className="sv-menu-note">{unavailable(limited)}</small>
                                    )}
                                </div>
                            )
                        })}
                        <small>Nothing is lost: coordinates jump the marker, and copying gives what is drawn.</small>
                    </div>

                    <div className="sv-menu-section">
                        <span className="sv-menu-title">Which way it reads</span>
                        <label className="sv-menu-check">
                            <input
                                type="checkbox"
                                checked={draft.reverse}
                                onChange={(event) => setDraft((current) => ({ ...current, reverse: event.target.checked }))}
                            />
                            Reverse complement
                        </label>
                        {/* What it will do, rather than what it is: the switch means
                            the opposite thing on the two strands, and a reader should
                            not have to work out which one they are on to predict the
                            press. */}
                        <small>
                            {readingReverse
                                ? 'Reading on the reverse strand now; this reads forward instead.'
                                : 'Reading forward now; this reads from the other end.'}
                        </small>
                    </div>

                    <div className="sv-menu-section">
                        <span className="sv-menu-title">Flanking sequence</span>
                        <div className="sv-flank-grid">
                            <span />
                            <span className="sv-flank-head">5′</span>
                            <span className="sv-flank-head">3′</span>
                            {FLANK_LEVELS.map((level) => (
                                <FlankRow
                                    key={level}
                                    label={FLANK_COPY[level]}
                                    value={draft.flanks[level]}
                                    onChange={(end, next) => editFlank(level, end, next)}
                                />
                            ))}
                        </div>
                        <small>Upstream and downstream of the feature, whichever strand it is on.</small>
                    </div>

                    <div className="sv-menu-section">
                        <span className="sv-menu-title">What else to draw</span>
                        <label className="sv-menu-check">
                            <input
                                type="checkbox"
                                checked={draft.protein}
                                onChange={(event) => setDraft((current) => ({ ...current, protein: event.target.checked }))}
                            />
                            Display amino acid sequence
                        </label>
                        <small>
                            {proteinAvailable
                                ? 'A letter over each codon, where there is coding sequence.'
                                : 'Needs one reading frame: open a transcript, an exon or an intron.'}
                        </small>
                    </div>

                    <div className="sv-menu-actions">
                        <small>Changes take effect with Apply.</small>
                        <button type="button" onClick={close}>Cancel</button>
                        <button type="button" className="primary" onClick={publish}>Apply</button>
                    </div>
                </ControlMenu>
            ) : null}
        </>
    )
}

function FlankRow({ label, value, onChange }) {
    return (
        <>
            <span>{label}</span>
            <label>
                <input
                    type="text"
                    inputMode="numeric"
                    maxLength="6"
                    value={value.five}
                    aria-label={`${label}: bases of 5′ flanking sequence`}
                    onChange={(event) => onChange('five', event.target.value)}
                />
                bp
            </label>
            <label>
                <input
                    type="text"
                    inputMode="numeric"
                    maxLength="6"
                    value={value.three}
                    aria-label={`${label}: bases of 3′ flanking sequence`}
                    onChange={(event) => onChange('three', event.target.value)}
                />
                bp
            </label>
        </>
    )
}

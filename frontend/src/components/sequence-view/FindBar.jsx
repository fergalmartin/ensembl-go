import { useEffect, useRef, useState } from 'react'

import GenomeColorPicker from '../GenomeColorPicker'
import { VerticalChevronGlyph } from '../focusDrawerChrome'
import { genomeColorPalette } from '../../genomeColorSchemes'
import { readableTextOn } from '../../utils/genomePillColors'
import {
    FIND_COLOURS,
    FIND_LITERAL,
    FIND_REGEX,
    MAX_PATTERNS,
    matchLabel,
    movePattern,
    newPattern,
    patternErrors,
    savedPatternFor,
} from '../../utils/findPatterns'

function MagnifierGlyph() {
    return (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
    )
}

function SpinnerGlyph() {
    return (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
            <path d="M12 3a9 9 0 1 0 9 9">
                <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.8s" repeatCount="indefinite" />
            </path>
        </svg>
    )
}

function CloseGlyph() {
    return (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
        </svg>
    )
}

/**
 * The find box, in one of its two modes.
 *
 * **One or the other, never both.** The face of the control on the bar opens
 * the simple box; the chevron opens the list. They are two ways of saying the
 * same thing rather than a small version and a big version of one thing, and a
 * band that showed the list underneath the box invited a reader to use both at
 * once and then wonder which of them was in force.
 *
 * **Simple** is a search bar like the one beside it: type, press the
 * magnifier, step through what it found. Nothing happens as the reader types,
 * because what is being typed into is a scan of a whole chromosome and a
 * five-character pattern would start five of them.
 *
 * **Full** is the list: several patterns at once, each in its own colour, in
 * the order that decides which of them wins a base they both cover. It is a
 * draft with Cancel and Apply, the way every other menu in these two views
 * edits several things at once -- and Apply hands back to the simple box, with
 * the patterns it applied written there as `[P1,P2]`.
 *
 * That notation is what makes the two one control. After Apply the reader is in
 * an ordinary simple search, countable and steppable, whose text happens to
 * name the list; and a reader who knows the notation can reorder or prune it
 * without opening the list at all.
 */
export default function FindBar({
    mode = 'simple',
    // What is in the simple box, and how it is to be read.
    query = '',
    kind = FIND_LITERAL,
    // What was last submitted, so the box can say whether it is in step.
    applied = '',
    patterns = [],
    matches = null,
    saved = true,
    isLight = false,
    config = null,
    onQuery,
    onKind,
    onSubmit,
    onPatterns,
    onApplyPatterns,
    onMode,
    onClose,
}) {
    const box = useRef(null)
    useEffect(() => { box.current?.focus() }, [mode])

    // The find colours first, then the genome palette. A new pattern takes the
    // first one nothing else is wearing, so the order decides what a reader
    // gets without choosing -- and the genome palette's first entry is the
    // Ensembl blue, which is a hair from the blue this view fills an exon
    // with. The rest stay available in the picker.
    const palette = [...new Set([
        ...FIND_COLOURS,
        ...genomeColorPalette(config),
        ...patterns.map((item) => item.colour),
    ])]

    if (mode === 'full') {
        return (
            <FindList
                patterns={patterns}
                counts={matches?.counts || null}
                palette={palette}
                saved={saved}
                isLight={isLight}
                onApply={onApplyPatterns}
                onCancel={() => onMode?.('simple')}
                onChange={onPatterns}
            />
        )
    }

    // The colour a match will be drawn in, shown only where it is a fact the
    // reader has already decided: a pattern of theirs, out of the list. An
    // ad-hoc search has a colour too, but it is one this view picked, and a
    // swatch offering to change it is a setting nobody asked for on a box they
    // opened to type one word into.
    const known = savedPatternFor(query, kind, patterns)
    const total = matches?.total ?? 0
    const stale = applied !== query.trim()
    const label = matches?.pending ? 'Searching…'
        : matches?.error ? 'Could not search'
            : stale ? ''
                : matches?.searching ? matchLabel(matches.at, total, { truncated: matches.truncated })
                    : ''

    const submit = (event) => {
        event?.preventDefault?.()
        onSubmit?.()
    }

    return (
        <form className="sv-findbar" data-sequence-find-bar="simple" onSubmit={submit}>
            <div className="sv-findbar-row">
                {known ? (
                    <span
                        className="sv-find-colour"
                        style={{ background: known.colour }}
                        title={`Drawn in this colour. Pattern ${patterns.indexOf(known) + 1} of your list.`}
                    />
                ) : null}
                <input
                    ref={box}
                    className="sv-find-box"
                    value={query}
                    maxLength={500}
                    spellCheck={false}
                    autoComplete="off"
                    data-sequence-find-input="true"
                    placeholder={kind === FIND_REGEX
                        ? 'A pattern, e.g. ATG[ACGT]{3} — or [P1,P2] for your saved ones'
                        : 'A string, e.g. ATGGCC — or [P1,P2] for your saved ones'}
                    aria-label="Find in this region"
                    onChange={(event) => onQuery?.(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === 'Escape') { event.preventDefault(); onClose?.() }
                        // Enter submits through the form. Shift-Enter steps
                        // back through what is already found, which is what a
                        // find box does and what the buttons do.
                        if (event.key === 'Enter' && event.shiftKey && !stale) {
                            event.preventDefault()
                            matches?.step?.(-1)
                        }
                    }}
                />
                {/* Against the field, the way the location box's own button
                    is: the two are one control -- a thing to type in and the
                    thing that submits it -- and a switch standing between them
                    read as a third, unrelated step in the middle of a pair. */}
                <button
                    type="submit"
                    className="sv-icon-button sv-find-go"
                    disabled={matches?.pending || !query.trim()}
                    data-sequence-find-go="true"
                    title="Search this region (Enter)"
                    aria-label="Search this region"
                >
                    {matches?.pending ? <SpinnerGlyph /> : <MagnifierGlyph />}
                </button>

                {/* String or pattern, on the box rather than behind a menu: it
                    changes what the same typing means, so a reader has to be
                    able to see which one is on without going to look. */}
                <div className="sv-find-kind" role="group" aria-label="How to read what was typed">
                    {[[FIND_LITERAL, 'Aa', 'Match the characters exactly'],
                        [FIND_REGEX, '.*', 'Read it as a regular expression']].map(([id, glyph, hint]) => (
                        <button
                            key={id}
                            type="button"
                            className={kind === id ? 'selected' : ''}
                            aria-pressed={kind === id}
                            data-sequence-find-kind={id}
                            onClick={() => onKind?.(id)}
                            title={hint}
                        >
                            {glyph}
                        </button>
                    ))}
                </div>
                <span className={`sv-find-count ${matches?.error ? 'none' : ''}`} role="status">
                    {label}
                </span>

                <button type="button" className="sv-icon-button" disabled={!total || stale}
                    data-sequence-find-prev="true"
                    onClick={() => matches?.step?.(-1)} title="Previous match (Shift-Enter)" aria-label="Previous match">
                    <VerticalChevronGlyph size={13} />
                </button>
                <button type="button" className="sv-icon-button" disabled={!total || stale}
                    data-sequence-find-next="true"
                    onClick={() => matches?.step?.(1)} title="Next match" aria-label="Next match">
                    <VerticalChevronGlyph size={13} pointsDown />
                </button>
                <button type="button" className="sv-icon-button" data-sequence-find-close="true"
                    onClick={onClose} title="Close the find box (Esc)" aria-label="Close the find box">
                    <CloseGlyph />
                </button>
            </div>

            {matches?.error ? <div className="sv-find-error" role="alert">{matches.error}</div> : null}
            {!matches?.error && !matches?.pending && applied && !stale && total === 0 ? (
                <div className="sv-find-note" role="status">Nothing in this region matches.</div>
            ) : null}
            {matches?.truncated ? (
                <div className="sv-find-note" role="status">
                    {`All ${total.toLocaleString()} were counted; the first `
                        + `${matches.listed.toLocaleString()} can be stepped through.`}
                </div>
            ) : null}
        </form>
    )
}

/**
 * The whole list, as a draft.
 *
 * Cancel and Apply because that is how the alignment explorer edits several
 * things at once, and because a list of patterns is several things: reordering
 * three of them one keystroke at a time would start three scans of a
 * chromosome, and two of those answers are of no interest to anybody.
 */
function FindList({ patterns, counts, palette, saved, isLight, onApply, onCancel, onChange }) {
    const [draft, setDraft] = useState(() => (patterns.length ? patterns : [newPattern([], palette)]))
    const [dragged, setDragged] = useState(null)
    const [over, setOver] = useState(null)
    const [colourFor, setColourFor] = useState(null)

    const errors = patternErrors(draft)
    const chosen = draft.find((item) => item.id === colourFor) || null
    const usable = draft.filter((item) => item.enabled && item.pattern && !errors[item.id])

    const patch = (id, value) => setDraft((list) => list.map(
        (item) => (item.id === id ? { ...item, ...value } : item),
    ))

    return (
        <div className="sv-findbar full" data-sequence-find-bar="full">
            <div className="sv-find-list">
                <small>
                    Highest priority at the top: where two patterns cover a base, the upper one is
                    drawn. Drag the grip to reorder, or focus it and use ↑ / ↓.
                </small>
                {draft.map((item, index) => (
                    <div
                        key={item.id}
                        className={`sv-find-row ${item.enabled ? '' : 'off'} ${over === item.id ? 'drop' : ''}`}
                        onDragOver={(event) => {
                            if (!dragged) return
                            event.preventDefault()
                            event.dataTransfer.dropEffect = 'move'
                            setOver(item.id)
                        }}
                        onDrop={(event) => {
                            event.preventDefault()
                            setDraft((list) => movePattern(list, dragged, item.id))
                            setDragged(null)
                            setOver(null)
                        }}
                    >
                        <button
                            type="button"
                            className="sv-find-grip"
                            draggable
                            aria-label={`Move pattern ${index + 1}`}
                            title="Drag to reorder; arrow keys also move this one"
                            onDragStart={(event) => {
                                setDragged(item.id)
                                event.dataTransfer.setData('text/plain', item.id)
                                event.dataTransfer.effectAllowed = 'move'
                            }}
                            onDragEnd={() => { setDragged(null); setOver(null) }}
                            onKeyDown={(event) => {
                                if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return
                                event.preventDefault()
                                const target = draft[index + (event.key === 'ArrowUp' ? -1 : 1)]
                                if (target) setDraft((list) => movePattern(list, item.id, target.id))
                            }}
                        >
                            ⠿
                        </button>
                        {/* Which place in the list this is, because that is what
                            the reader types into the simple box to name it. */}
                        <span className="sv-find-place">P{index + 1}</span>
                        <input
                            type="checkbox"
                            checked={item.enabled}
                            aria-label={`Search for pattern ${index + 1}`}
                            onChange={(event) => patch(item.id, { enabled: event.target.checked })}
                        />
                        <button
                            type="button"
                            className="sv-find-colour"
                            style={{ background: item.colour }}
                            aria-label={`Colour for pattern ${index + 1}`}
                            title="Change this pattern's colour"
                            onClick={() => setColourFor(item.id)}
                        />
                        <input
                            className="sv-find-box"
                            value={item.pattern}
                            maxLength={500}
                            spellCheck={false}
                            autoComplete="off"
                            aria-label={`Pattern ${index + 1}`}
                            aria-invalid={Boolean(errors[item.id])}
                            placeholder={item.kind === FIND_REGEX ? 'e.g. ATG[ACGT]{3}' : 'e.g. ATG'}
                            onChange={(event) => patch(item.id, { pattern: event.target.value })}
                        />
                        <select
                            aria-label={`How to read pattern ${index + 1}`}
                            value={item.kind}
                            onChange={(event) => patch(item.id, { kind: event.target.value })}
                        >
                            <option value={FIND_LITERAL}>String</option>
                            <option value={FIND_REGEX}>Regex</option>
                        </select>
                        <span className="sv-find-tally">
                            {counts?.[item.id] === undefined ? '' : counts[item.id].toLocaleString()}
                        </span>
                        <button
                            type="button"
                            className="sv-find-delete"
                            aria-label={`Delete pattern ${index + 1}`}
                            title="Delete this pattern"
                            // Deleting the last one empties it rather than
                            // taking it away. A list with no rows in it has
                            // nothing to type into, so the reader who cleared
                            // their one pattern would have to press Add before
                            // they could search again -- which is a step
                            // between them and the thing they came to do.
                            onClick={() => setDraft((list) => (list.length > 1
                                ? list.filter((other) => other.id !== item.id)
                                : [newPattern([], palette)]))}
                        >
                            ×
                        </button>
                        {errors[item.id] ? (
                            <div className="sv-find-error" role="alert">{errors[item.id]}</div>
                        ) : null}
                    </div>
                ))}
                <div className="sv-find-actions">
                    <button
                        type="button"
                        disabled={draft.length >= MAX_PATTERNS}
                        data-sequence-find-add="true"
                        onClick={() => setDraft((list) => [...list, newPattern(list, palette)])}
                    >
                        + Add a pattern
                    </button>
                    <small className={saved ? '' : 'sv-find-error'} role="status">
                        {saved
                            ? 'Apply searches the whole region in focus and hands back to the find box, '
                                + 'with these written there as their places in this list. Case is ignored. '
                                + 'Remembered on this device.'
                            : 'Could not remember these patterns on this device.'}
                    </small>
                    <button type="button" data-sequence-find-cancel="true" onClick={onCancel}>Cancel</button>
                    <button
                        type="button"
                        className="primary"
                        disabled={!usable.length}
                        data-sequence-find-apply="true"
                        onClick={() => { onChange?.(draft); onApply?.(draft) }}
                    >
                        Apply
                    </button>
                </div>
            </div>

            <GenomeColorPicker
                isOpen={Boolean(chosen)}
                theme={isLight ? 'light' : 'dark'}
                title="Find colour"
                subtitle={chosen?.pattern || 'New pattern'}
                paletteHint="Choose a palette colour or mix your own."
                currentColor={chosen?.colour}
                palette={palette}
                defaultColor={palette[0]}
                renderPreview={(colour) => (
                    <div className="sv-find-preview" style={{ background: colour, color: readableTextOn(colour) }}>
                        {chosen?.pattern || 'ATG'}
                    </div>
                )}
                onApply={(colour) => patch(colourFor, { colour })}
                onClose={() => setColourFor(null)}
            />
        </div>
    )
}

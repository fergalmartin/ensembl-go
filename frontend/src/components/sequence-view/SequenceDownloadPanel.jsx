import { useMemo, useState } from 'react'

import {
    EXPORT_FORMATS,
    ORIENTATION_FORWARD,
    ORIENTATION_REVERSE,
    ORIENTATION_VIEW,
    SHAPE_FULL,
    SHAPE_SHOWN,
    defaultFlankFor,
    estimateColouredBytes,
    exportFormat,
    formatBytes,
    formatIsColoured,
    withFlank,
} from '../../utils/sequenceViewExport'
import { groupDigits } from '../../utils/sequenceViewDisplay'

/** A count the reader typed, as a number the export can use. */
function count(text) {
    const parsed = Number(String(text ?? '').replace(/,/g, '').trim())
    return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0
}

/**
 * The download panel: what to write, how much of it, which way round, in what
 * shape and in what format.
 *
 * The wide slot beside the focus list, the same place the Highlights panel
 * opens -- a reader setting up a download is comparing it against the levels in
 * the list beside it, and a modal over the sequence would hide the thing being
 * described.
 *
 * The sections are in the order the answers depend on each other.
 *
 *   - **What** is built from where the reader is standing: the records they
 *     have selected, and every level of the chain that is actually set, from
 *     the whole location down to the one exon in focus.
 *   - **Flanking sequence** and **orientation** are the two things a reader
 *     almost always wants of a gene and could not previously ask for. Both are
 *     seeded from the settings they are already reading with.
 *   - **Shape** is the difference between the file matching the screen and the
 *     file being every base.
 *   - **Format** is last, because what a format can carry decides whether the
 *     rest of it survives the trip: a collapsed shape marks its breaks in RTF
 *     and HTML, can only count them in a FASTA header, and cannot say anything
 *     at all in plain text.
 *
 * Nothing here is refused. The button opens the save box, which is where the
 * file is named and where anything worth knowing about its size is said.
 */
export default function SequenceDownloadPanel({
    targets = [],
    // What to offer before the reader has chosen: the level they are actually
    // orientation. The panel opens on a fresh mount every time, so this is the
    // whole of "it should already have my exon selected" -- and it stops
    // applying the moment they pick something else.
    preferredId = '',
    flanks,
    isLight,
    proteinAvailable = false,
    onRequest,
    onClose,
}) {
    const border = isLight ? 'border-gray-200' : 'border-gray-700'
    const heading = isLight ? 'text-gray-500' : 'text-gray-400'
    const text = isLight ? 'text-gray-700' : 'text-gray-300'
    const muted = isLight ? 'text-gray-500' : 'text-gray-400'
    const rowOn = isLight ? 'bg-blue-50 border-blue-300' : 'bg-blue-950/40 border-blue-700'
    const rowOff = isLight ? 'border-transparent hover:bg-gray-50' : 'border-transparent hover:bg-gray-800/60'
    const field = isLight
        ? 'bg-white border border-gray-300 text-gray-900 focus:border-blue-500'
        : 'bg-gray-700 border border-gray-600 text-gray-100 focus:border-blue-400'

    const [targetId, setTargetId] = useState('')
    const [shape, setShape] = useState(SHAPE_SHOWN)
    const [orientation, setOrientation] = useState(ORIENTATION_VIEW)
    const [format, setFormat] = useState('rtf')
    const [gutters, setGutters] = useState(true)
    const [headings, setHeadings] = useState(true)
    const [withProtein, setWithProtein] = useState(false)
    // Held as text so a half-typed number is not read as a zero under the
    // reader's fingers. Null until they touch it, which is what lets the
    // default follow the level they switch to.
    const [flank, setFlank] = useState(null)

    // Whatever is on offer, and the first of those when what was chosen has gone
    // -- stepping up a level while the panel is open must not leave it holding a
    // target that no longer exists. Resolved rather than corrected, so the list
    // moving under the reader costs no render of its own.
    const bare = useMemo(() => (
        targets.find((item) => item.id === targetId)
        || targets.find((item) => item.id === preferredId)
        || targets[0]
        || null
    ), [targets, targetId, preferredId])

    // The reader's own setting for whatever level this is, until they say
    // otherwise -- so opening the panel on a transcript offers the flank they
    // read transcripts with.
    const suggested = defaultFlankFor(bare?.level, flanks)
    const five = flank ? count(flank.five) : suggested.five
    const three = flank ? count(flank.three) : suggested.three

    const target = useMemo(
        () => (bare ? withFlank(bare, { five, three }) : null),
        [bare, five, three],
    )
    // A transcript read in its own coordinates, rather than a stretch of
    // chromosome. Two of the questions below do not apply to one.
    const spliced = bare?.kind === 'reading'
    const bases = target?.bases || 0
    const coloured = formatIsColoured(format)
    const descriptor = exportFormat(format)
    const estimate = estimateColouredBytes(bases)

    const editFlank = (part, value) => setFlank((held) => ({
        five, three, ...(held || {}), [part]: value,
    }))

    return (
        <div className="flex h-full flex-col" data-sequence-download-panel="true">
            <div className={`flex items-center justify-between border-b px-4 py-3 ${border}`}>
                <h3 className={`text-xs font-semibold uppercase tracking-wide ${heading}`}>
                    Download
                </h3>
                <button type="button" onClick={onClose} className={`text-xs ${muted} hover:underline`}>
                    Close
                </button>
            </div>

            {/* Two columns rather than one long scroll. Every section is short;
                it was only their stacking that made the panel something to
                scroll through, and the width to lay them out side by side costs
                nothing now that the slot hangs over the sequence. */}
            <div className="flex-1 overflow-y-auto px-4 py-3 themed-scrollbar">
                <section className="mb-4">
                    <h4 className={`mb-1.5 text-[11px] font-semibold uppercase tracking-wide ${heading}`}>
                        What
                    </h4>
                    {targets.length === 0 ? (
                        <p className={`text-xs ${muted}`}>Nothing is in focus yet.</p>
                    ) : (
                        <div className="space-y-1">
                            {targets.map((item) => (
                                <label
                                    key={item.id}
                                    data-download-target={item.id}
                                    className={`flex cursor-pointer items-center gap-2 rounded border px-2 py-1 ${
                                        item.id === bare?.id ? rowOn : rowOff
                                    }`}
                                >
                                    <input
                                        type="radio"
                                        name="sequence-download-target"
                                        checked={item.id === bare?.id}
                                        onChange={() => setTargetId(item.id)}
                                    />
                                    {/* One line apiece. Two was fine for the two
                                        or three a location offers and awkward
                                        for the six a reader with records
                                        selected has -- and that is exactly when
                                        they need to see the whole list. */}
                                    <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                                        <span className={`flex-none text-sm ${text}`}>{item.label}</span>
                                        <span className={`min-w-0 flex-1 truncate text-[11px] ${muted}`}>
                                            {item.detail}
                                        </span>
                                        {/* Blank rather than a nought where a
                                            reading has not been fetched yet:
                                            not knowing its length and it
                                            having none are different facts. */}
                                        <span className={`flex-none text-[11px] ${muted}`}>
                                            {item.bases > 0
                                                ? `${groupDigits(item.bases)} ${item.unit || 'bp'}`
                                                : ''}
                                        </span>
                                    </span>
                                </label>
                            ))}
                        </div>
                    )}
                </section>

                <div className="flex gap-5">
                <div className="flex-1 min-w-0 space-y-4">
                {/* A location is a window the reader already drew, and a
                    dragged selection likewise: neither has a 5' end to extend
                    from, which is why the flank is offered for a gene, a
                    transcript and a feature and not for those. */}
                {bare?.flankable ? (
                    <section data-download-flank="true">
                        <h4 className={`mb-1.5 text-[11px] font-semibold uppercase tracking-wide ${heading}`}>
                            Flanking sequence
                        </h4>
                        <div className="flex items-center gap-2">
                            {[['five', '5\u2032'], ['three', '3\u2032']].map(([part, label]) => (
                                <label key={part} className="flex flex-1 items-center gap-1.5">
                                    <span className={`text-xs ${muted}`}>{label}</span>
                                    <input
                                        type="number"
                                        min="0"
                                        data-download-flank-part={part}
                                        value={part === 'five' ? (flank?.five ?? five) : (flank?.three ?? three)}
                                        onChange={(event) => editFlank(part, event.target.value)}
                                        className={`w-full rounded px-1.5 py-1 text-xs outline-none ${field}`}
                                    />
                                    <span className={`text-xs ${muted}`}>bp</span>
                                </label>
                            ))}
                        </div>
                        <p className={`mt-1 text-[11px] ${muted}`}>
                            {'On every record, by its own strand.'}
                        </p>
                    </section>
                ) : null}

                {/* A reading is already the right way round: a transcript's
                    own sequence is spelled 5' to 3' whichever strand it is on,
                    and there is no forward strand of a protein. The same goes
                    for the shape -- nothing was collapsed, because nothing was
                    laid out over a stretch of chromosome. */}
                {spliced ? null : (
                <section data-download-orientation="true">
                    <h4 className={`mb-1.5 text-[11px] font-semibold uppercase tracking-wide ${heading}`}>
                        Orientation
                    </h4>
                    <div className="space-y-1">
                        {[
                            [ORIENTATION_VIEW, 'Relative to view', 'Same orientation as the current view'],
                            [ORIENTATION_FORWARD, 'Forward', 'Force the forward strand'],
                            [ORIENTATION_REVERSE, 'Reverse', 'Force the reverse strand'],
                        ].map(([id, label, hint]) => (
                            <label
                                key={id}
                                data-download-orientation-option={id}
                                className="flex cursor-pointer items-start gap-2"
                            >
                                <input
                                    type="radio"
                                    name="sequence-download-orientation"
                                    className="mt-0.5"
                                    checked={orientation === id}
                                    onChange={() => setOrientation(id)}
                                />
                                <span className="min-w-0">
                                    <span className={`block text-sm ${text}`}>{label}</span>
                                    <span className={`block text-[11px] ${muted}`}>{hint}</span>
                                </span>
                            </label>
                        ))}
                    </div>
                </section>
                )}

                {/* Only the coloured formats have anything to include: a FASTA
                    has no gutters to print and no lane to draw. */}
                {coloured ? (
                    <section>
                        <h4 className={`mb-1.5 text-[11px] font-semibold uppercase tracking-wide ${heading}`}>
                            Include
                        </h4>
                        <div className="space-y-1">
                            <label className="flex cursor-pointer items-center gap-2">
                                <input type="checkbox" checked={gutters} onChange={() => setGutters((on) => !on)} />
                                <span className={`text-sm ${text}`}>Coordinates either side</span>
                            </label>
                            <label className="flex cursor-pointer items-center gap-2">
                                <input type="checkbox" checked={headings} onChange={() => setHeadings((on) => !on)} />
                                <span className={`text-sm ${text}`}>A heading per record</span>
                            </label>
                            {/* Nothing to draw it over where the protein *is*
                                the sequence. */}
                            {bare?.reading === 'protein' ? null : (
                            <label className={`flex items-center gap-2 ${proteinAvailable ? 'cursor-pointer' : 'cursor-default opacity-50'}`}>
                                <input
                                    type="checkbox"
                                    disabled={!proteinAvailable}
                                    checked={withProtein && proteinAvailable}
                                    onChange={() => setWithProtein((on) => !on)}
                                />
                                <span className={`text-sm ${text}`}>
                                    The protein over its codons
                                </span>
                            </label>
                            )}
                        </div>
                    </section>
                ) : null}
                </div>

                <div className="flex-1 min-w-0 space-y-4">
                {spliced ? null : (
                <section data-download-shape="true">
                    <h4 className={`mb-1.5 text-[11px] font-semibold uppercase tracking-wide ${heading}`}>
                        Shape
                    </h4>
                    <div className="space-y-1">
                        <label className="flex cursor-pointer items-start gap-2">
                            <input
                                type="radio"
                                name="sequence-download-shape"
                                className="mt-0.5"
                                checked={shape === SHAPE_SHOWN}
                                onChange={() => setShape(SHAPE_SHOWN)}
                            />
                            <span className="min-w-0">
                                <span className={`block text-sm ${text}`}>As shown</span>
                                {/* What becomes of a break depends on what the
                                    format can say. RTF and HTML draw the marker
                                    the screen draws; a FASTA header can only
                                    count what was removed; plain text cannot say
                                    anything at all -- and saying so is the
                                    difference between a spliced sequence and a
                                    quietly wrong one. */}
                                <span className={`block text-[11px] ${muted}`}>
                                    {coloured
                                        ? 'Collapsed stretches left out, breaks are marked in the sequence.'
                                        : format === 'fasta'
                                            ? 'Collapsed stretches left out; the header says how much was removed.'
                                            : 'Collapsed stretches left out, with nothing to mark where.'}
                                </span>
                            </span>
                        </label>
                        <label className="flex cursor-pointer items-start gap-2">
                            <input
                                type="radio"
                                name="sequence-download-shape"
                                className="mt-0.5"
                                checked={shape === SHAPE_FULL}
                                onChange={() => setShape(SHAPE_FULL)}
                            />
                            <span className="min-w-0">
                                <span className={`block text-sm ${text}`}>Whole span</span>
                                <span className={`block text-[11px] ${muted}`}>
                                    Every base of the range, nothing left out.
                                </span>
                            </span>
                        </label>
                    </div>
                </section>
                )}

                <section>
                    <h4 className={`mb-1.5 text-[11px] font-semibold uppercase tracking-wide ${heading}`}>
                        Format
                    </h4>
                    {/* One hint, for whichever is chosen, rather than four at
                        once. The four together were the tallest thing in the
                        panel and three of them described something the reader
                        had not picked. */}
                    <div className="space-y-0.5">
                        {EXPORT_FORMATS.map((item) => (
                            <label
                                key={item.id}
                                data-download-format={item.id}
                                className="flex cursor-pointer items-center gap-2"
                            >
                                <input
                                    type="radio"
                                    name="sequence-download-format"
                                    checked={item.id === format}
                                    onChange={() => setFormat(item.id)}
                                />
                                <span className={`truncate text-sm ${text}`}>{item.label}</span>
                            </label>
                        ))}
                    </div>
                    <p className={`mt-1 text-[11px] ${muted}`}>{descriptor.hint}</p>
                </section>
                </div>
                </div>

            </div>

            <div className={`flex-none border-t px-4 py-3 ${border}`}>
                {/* Opens the save box. What the file is called, and anything
                    worth knowing before it is written, is asked there -- not
                    decided for the reader and reported afterwards. */}
                <button
                    type="button"
                    data-download-run="true"
                    disabled={!target}
                    onClick={() => onRequest?.({
                        target, shape, orientation, format, gutters, headings, withProtein,
                    })}
                    className={`w-full rounded px-3 py-2 text-sm font-medium transition-colors ${
                        !target
                            ? (isLight ? 'bg-gray-200 text-gray-500' : 'bg-gray-700 text-gray-400')
                            : 'bg-blue-600 text-white hover:bg-blue-500'
                    }`}
                >
                    {`Download ${descriptor.extension.toUpperCase()}…`}
                </button>
                {target ? (
                    <p className={`mt-1.5 text-center text-[11px] ${muted}`}>
                        {[
                            target.entries.length > 1 ? `${target.entries.length} records` : '',
                            bases > 0 ? `${groupDigits(bases)} ${target.unit || 'bp'}` : '',
                            coloured ? `~${formatBytes(estimate)}` : '',
                        ].filter(Boolean).join(' · ')}
                    </p>
                ) : null}
            </div>
        </div>
    )
}

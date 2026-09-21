import {
    BrowserGlyph,
    CloseGlyph,
    CopyGlyph,
    DownloadGlyph,
    TargetGlyph,
} from '../focusDrawerChrome'
import {
    KIND_GENOMIC,
    KIND_HINTS,
    KIND_LABELS,
    KIND_NOUNS,
    KIND_PROTEIN,
    MODES,
    counted,
    modeOffer,
} from '../../utils/transcriptSequenceView'

/**
 * Which reading the sequence below is, what is highlighted in it, and what to do
 * with either.
 *
 * **One bar, because they were one set of controls.** The reading and the
 * highlight began as two floating bars, and both carried copy and download --
 * the same two actions, differing only in how much they acted on. Two bars, four
 * buttons, two answers to "copy what?". Merged, there is one row of actions, and
 * what they act on is simply whether anything is highlighted: the stretch if
 * there is one, the whole reading if there is not. Every button says which in its
 * own title, so the reader is never guessing.
 *
 * **Where it is.** In a band of its own between the control bar and the first
 * row, centred on the sequence, drawn as the floating pill the genomic view's
 * selection bar is drawn as -- same panel colour, accent border, radius and
 * shadow. It is a band rather than a box laid over the rows because it is always
 * there, and a bar that permanently covered the top line of the sequence would
 * take a row from every reader for the whole time they read.
 *
 * It was a panel in the focus drawer before that, which was the real mistake:
 * where a control *belongs* is not where a reader will *find* it, and these
 * readings are most of why somebody opens a transcript at all.
 *
 * **Absent, not empty**, where there is no transcript in focus. At a location or
 * a gene there is one reading, so a bar offering four of which three are
 * unusable would be a control saying nothing, and a band of furniture over every
 * screen of sequence. The genomic view keeps its own selection bar for those
 * levels; here it does not draw one, because this is it.
 *
 * **The highlight is a second row under the first**, and only while there is
 * one, so the bar grows rather than something else appearing elsewhere. It says
 * what the stretch is *in the reading on screen* -- which changes as the reader
 * switches, because the same stretch of chromosome is 151 bases of a transcript,
 * 151 bases of its CDS, or 51 residues of its protein, and sometimes none of it
 * at all.
 */
export default function SequenceReadingBar({
    mode = KIND_GENOMIC,
    answers = {},
    hasTranscript = false,
    coding = true,
    isLight = false,
    // The highlight in this reading's own positions, and the stretch of
    // chromosome it covers. Either may be absent: there may be no highlight, and
    // a highlight outside the coding sequence has no positions in a CDS.
    span = null,
    range = null,
    chrom = '',
    onChange,
    onCopy,
    onDownload,
    onFocusRegion,
    onBrowse,
    onClearHighlight,
}) {
    const highlighted = Boolean(range)
    const genomicReading = mode === KIND_GENOMIC

    /**
     * Whether copying and downloading will act on the highlight here.
     *
     * Not simply whether there is one. A stretch can be held and have no
     * positions in the reading on screen -- a 5' UTR highlight looked at as CDS
     * -- and there is nothing of it to take, so the actions fall back to the
     * whole reading and must say so. Keying the titles off the stretch's mere
     * existence made them promise "the highlighted stretch" and hand over ten
     * thousand bases.
     */
    const acts = genomicReading ? highlighted : Boolean(span)
    const what = acts ? 'the highlighted stretch' : `the whole ${KIND_NOUNS[mode]}`

    // Both of these put the reader somewhere on the chromosome, so both need a
    // stretch of it to put them at -- and a protein's residues are not one. They
    // do have a genomic span, through their codons, and this view knows it; the
    // judgement that jumping there reads as a non-sequitur is the reason they are
    // refused rather than any difficulty in working it out. The title says where
    // to go instead rather than leaving a dead control unexplained.
    const placeable = highlighted && mode !== KIND_PROTEIN
    const placeWhy = !highlighted
        ? 'Highlight a stretch first'
        : 'A protein’s residues are not a stretch of chromosome — switch to CDS for the bases that spell them'

    return (
        <div className="sv-reading-track" data-sequence-mode-bar="true">
            <div
                className={`sv-reading-bar ${isLight ? 'light' : ''}`}
                // The surface underneath takes a press as the start of a drag.
                onPointerDown={(event) => event.stopPropagation()}
            >
                <div className="sv-reading-row">
                    {MODES.map((kind) => {
                        const offer = modeOffer(kind, { hasTranscript, coding })
                        const on = kind === mode
                        const answer = answers[kind]
                        // Only for a reading already fetched, and only where it
                        // really has one. A blank is honest about not knowing yet;
                        // a nought would claim the transcript has none.
                        const size = answer?.status === 'ok' ? answer.length : null
                        return (
                            <button
                                key={kind}
                                type="button"
                                role="radio"
                                aria-checked={on}
                                disabled={!offer.on}
                                data-sequence-mode={kind}
                                data-sequence-mode-on={on ? 'true' : undefined}
                                className={`sv-mode-pick ${on ? 'on' : ''}`}
                                // What it is where it can be used, and why not
                                // where it cannot. Neither is readable off a
                                // one-word label.
                                title={offer.on ? KIND_HINTS[kind] : offer.why}
                                onClick={() => onChange?.(kind)}
                            >
                                <span className="sv-mode-name">{KIND_LABELS[kind]}</span>
                                {Number.isFinite(size) && size > 0 ? (
                                    <span className="sv-mode-size">
                                        {size.toLocaleString()}{kind === KIND_PROTEIN ? ' aa' : ' bp'}
                                    </span>
                                ) : null}
                            </button>
                        )
                    })}

                    <span className="sv-reading-split" aria-hidden="true" />

                    <Act
                        label="Copy as FASTA"
                        title={`Copy ${what} as FASTA`}
                        onClick={onCopy}
                    ><CopyGlyph size={14} /></Act>
                    <Act
                        label="Download as FASTA"
                        title={`Download ${what} as FASTA`}
                        onClick={onDownload}
                    ><DownloadGlyph size={14} /></Act>
                    <Act
                        label="Set as the location"
                        title={placeable ? 'Set this as the genomic location' : placeWhy}
                        disabled={!placeable}
                        onClick={onFocusRegion}
                    ><TargetGlyph size={15} /></Act>
                    <Act
                        label="Show in the genome browser"
                        title={placeable
                            ? 'Show the stretch of chromosome this covers in the genome browser'
                            : placeWhy}
                        disabled={!placeable}
                        onClick={onBrowse}
                    ><BrowserGlyph size={15} /></Act>
                </div>

                {highlighted ? (
                    <div className="sv-reading-highlight" data-sequence-highlight="true">
                        {/* Three shapes, because the stretch is three different
                            things to look at.

                            In the genomic reading its positions *are* the
                            coordinates, so printing both would print the same
                            number twice. In a spliced one they are the
                            transcript's own, and the coordinates follow as a
                            second fact. And a stretch can be real and still have
                            no positions here -- a 5' UTR highlight looked at as
                            CDS -- which is said plainly, because a row that went
                            blank would read as the highlight having been lost. */}
                        {genomicReading ? (
                            <>
                                <span className="sv-highlight-where">
                                    {chrom}:{range.start.toLocaleString()}&ndash;{range.end.toLocaleString()}
                                </span>
                                <span className="sv-highlight-size">
                                    {counted(range.end - range.start + 1, mode)}
                                </span>
                            </>
                        ) : (
                            <>
                                {span ? (
                                    <>
                                        <span className="sv-highlight-where">
                                            {span.s.toLocaleString()}&ndash;{span.e.toLocaleString()}
                                        </span>
                                        <span className="sv-highlight-size">
                                            {counted(span.e - span.s + 1, mode)}
                                        </span>
                                    </>
                                ) : (
                                    <span className="sv-highlight-size">
                                        Not in {mode === KIND_PROTEIN ? 'the protein' : `this ${KIND_NOUNS[mode]}`}
                                    </span>
                                )}
                                <span className="sv-highlight-coords">
                                    {chrom}:{range.start.toLocaleString()}&ndash;{range.end.toLocaleString()}
                                </span>
                            </>
                        )}
                        <Act
                            label="Clear the highlight"
                            title="Clear the highlight"
                            onClick={onClearHighlight}
                            className="sv-highlight-clear"
                        ><CloseGlyph size={13} /></Act>
                    </div>
                ) : null}
            </div>
        </div>
    )
}

function Act({ label, title, disabled = false, onClick, className = '', children }) {
    return (
        <button
            type="button"
            className={`sv-reading-act ${className}`}
            data-sequence-mode-action={label}
            aria-label={label}
            title={title || label}
            disabled={disabled}
            onClick={() => onClick?.()}
        >
            {children}
        </button>
    )
}

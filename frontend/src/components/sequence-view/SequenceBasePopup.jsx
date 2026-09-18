import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import { FONT_MONO } from '../../utils/typography'
import { CLASS_CODES } from '../../utils/sequenceViewPalette'
import { DEFAULT_PALETTE } from '../../utils/sequenceViewColours'
import { groupDigits } from '../../utils/sequenceViewDisplay'
import { biotypeText, strandText } from '../../utils/sequenceViewLabels'
import { placePopup } from '../../utils/sequenceViewPopup'
import { EyeGlyph, TargetGlyph } from '../focusDrawerChrome'

// The browser's own popup, to the pixel: same dark panel, same arrow, same type
// scale. A reader who has clicked a transcript in the genome browser should not
// have to notice that this is a different view's box.
const PANEL_BG = 'rgba(17, 24, 39, 0.97)'
const PANEL_W = 320
const PANEL_EDGE = '1px solid rgba(255,255,255,0.1)'
// The point's own edge is drawn harder than the panel's. It is eleven pixels of
// line against a dark page rather than three hundred, and at the panel's own
// opacity it read as nothing at all.
const POINT_EDGE = '1px solid rgba(255,255,255,0.32)'
// A square on its corner, half of it under the panel. Its diagonal is what
// reaches the base, so the side is the standoff over root two -- which is where
// 11 comes from, near enough to land on the cell.
const DIAMOND = 11
// How many isoforms a gene shows before the rest are folded away. A base in a
// well-annotated gene is in fifteen transcripts that mostly say the same thing,
// and a box taller than the screen answers the question worse than a short one.
const ISOFORMS_SHOWN = 4

// What a class is called in a sentence about one base, which is not always what
// the legend calls a stretch of them.
const CLASS_WORDS = {
    coding: 'Coding',
    noncoding: 'Non-coding exon',
    utr: 'UTR',
    utr5: "5' UTR",
    utr3: "3' UTR",
    intron: 'Intronic',
    mixed: 'Mixed',
    intergenic: 'Intergenic',
    genic: 'In a gene',
    cds: 'Coding',
}

const CLASS_SWATCH = {
    coding: CLASS_CODES.coding,
    noncoding: CLASS_CODES.noncoding,
    utr: CLASS_CODES.utr,
    utr5: CLASS_CODES.utr5,
    utr3: CLASS_CODES.utr3,
    intron: CLASS_CODES.intron,
    mixed: CLASS_CODES.mixed,
    intergenic: CLASS_CODES.intergenic,
    genic: CLASS_CODES.genic,
}

function ClassChip({ name, palette }) {
    const style = palette.style(CLASS_SWATCH[name] || '')
    if (!style) return <span style={{ fontWeight: 700 }}>{CLASS_WORDS[name] || name || '—'}</span>
    return (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span
                style={{
                    width: 9,
                    height: 9,
                    borderRadius: 2,
                    flex: '0 0 auto',
                    // Outlined where the sequence view outlines it, so the chip
                    // is the thing on screen rather than a second vocabulary.
                    background: style.outline ? 'transparent' : style.bg,
                    border: `1px solid ${style.bg}`,
                }}
            />
            <span style={{ fontWeight: 700 }}>{CLASS_WORDS[name] || name}</span>
        </span>
    )
}

/** The isoforms to list: the canonical one and a few, unless asked for all. */
function shownIsoforms(gene, expanded) {
    if (expanded.has(gene.id) || gene.transcripts.length <= ISOFORMS_SHOWN) return gene.transcripts
    // Ordered canonical-first by the backend, so the first few are the ones a
    // reader would have picked themselves.
    return gene.transcripts.slice(0, ISOFORMS_SHOWN)
}

/**
 * Whether the view is drawing this thing, and so whether it can be switched off.
 *
 * At a location every gene on screen is being drawn, so every one of them has an
 * eye. At a gene it is that gene's isoforms that are drawn and can be silenced,
 * and the other genes are context. At a transcript there is exactly one thing on
 * screen and hiding it would leave nothing -- so nothing there has an eye at all,
 * and the other isoforms offer to be read instead.
 */
function drawnHere(level, gene, transcript = null) {
    if (level === 'location') return true
    if (level === 'gene') return Boolean(gene.focus) && Boolean(transcript)
    return false
}

/**
 * The gene's eye governs the gene and everything under it.
 *
 * So that hiding a gene and then showing one of its isoforms leaves that isoform
 * on its own, which is the thing a reader wants at a crowded base and used to
 * take a second control to say.
 */
function geneSwitch(gene) {
    const ids = [gene.id, ...gene.transcripts.map((item) => item.id)]
    return gene.hidden ? { show: ids } : { hide: ids }
}

/**
 * An isoform's eye governs that isoform -- and, while its gene is hidden, means
 * "only this one".
 *
 * Showing an isoform of a hidden gene has to show the gene too or nothing would
 * happen at all: a hidden gene is silenced whole, whatever its isoforms say. And
 * since the gene is coming back, the reader is asked which isoform they meant,
 * not handed all of them again -- so the rest of what is listed goes quiet.
 */
function isoformSwitch(gene, transcript) {
    if (!transcript.hidden && !gene.hidden) return { hide: [transcript.id] }
    const others = gene.transcripts
        .filter((item) => item.id !== transcript.id)
        .map((item) => item.id)
    return gene.hidden
        ? { show: [gene.id, transcript.id], hide: others }
        : { show: [transcript.id] }
}

function isoformSwitchLabel(gene, transcript) {
    if (gene.hidden) return `only ${transcript.id} of this gene`
    return transcript.id
}

/** The class every isoform agrees on, or '' where they do not. */
function agreed(gene) {
    const said = new Set(gene.transcripts.map((transcript) => transcript.cls))
    return said.size === 1 ? [...said][0] : ''
}

function whereIn(transcript) {
    if (!transcript.kind) return ''
    const of = transcript.count ? ` of ${transcript.count}` : ''
    return `${transcript.kind} ${transcript.index}${of}`
}

/**
 * Everything known about one base, anchored to the base itself.
 *
 * The colours can only give one answer per base. Where genes overlap or isoforms
 * disagree that answer is "mixed", which is true and not what the reader wanted
 * to know -- so this is the long form: which genes cover it, what each calls it,
 * and which exon or intron of which isoform it is.
 *
 * The arrow meets the side of the base itself, so there is no doubt which of
 * sixty cells in a row the box is about -- and the base is ringed to say the
 * same thing from the other end. It sits to the right of the base by default,
 * which is where the eye goes next in a line of text, and flips to the left when
 * there is not room for it there.
 */
/** Read into something the view is not drawing. */
function SwitchButton({ what, onClick }) {
    return (
        <button
            type="button"
            onClick={onClick}
            title={`Read ${what} here`}
            aria-label={`Read ${what}`}
            style={{
                border: 'none',
                background: 'transparent',
                padding: 0,
                marginLeft: 'auto',
                flex: '0 0 auto',
                lineHeight: 0,
                cursor: 'pointer',
                color: '#93c5fd',
            }}
        >
            <TargetGlyph size={14} />
        </button>
    )
}

/** The same eye the drawer uses, sized for a line of this box. */
function EyeButton({ hidden, what, onClick }) {
    return (
        <button
            type="button"
            onClick={onClick}
            title={hidden ? `Show ${what} in the sequence` : `Hide ${what} from the sequence`}
            aria-label={hidden ? `Show ${what}` : `Hide ${what}`}
            aria-pressed={!hidden}
            style={{
                border: 'none',
                background: 'transparent',
                padding: 0,
                marginLeft: 'auto',
                flex: '0 0 auto',
                lineHeight: 0,
                cursor: 'pointer',
                color: hidden ? '#64748b' : '#93c5fd',
            }}
        >
            <EyeGlyph hidden={hidden} size={14} />
        </button>
    )
}

export default function SequenceBasePopup({
    popup, chrom, onHiddenChange, onFocusGene, onFocusTranscript, onClose,
    palette = DEFAULT_PALETTE,
}) {
    const [copied, setCopied] = useState('')
    const panelRef = useRef(null)
    // Where the box sits, and where its arrow sits inside it. Two numbers rather
    // than one because a box long enough to be pushed away from the window's
    // edge must still point at the base it is about -- the arrow slides down the
    // side instead of the box sliding off the screen.
    const [place, setPlace] = useState(null)
    // Which genes the reader has asked to see every isoform of.
    const [expanded, setExpanded] = useState(() => new Set())

    useEffect(() => {
        if (!copied) return undefined
        const timer = setTimeout(() => setCopied(''), 1400)
        return () => clearTimeout(timer)
    }, [copied])

    useEffect(() => {
        const onKey = (event) => { if (event.key === 'Escape') onClose?.() }
        window.addEventListener('keydown', onKey)
        // A resize re-lays out the rows under a box that is anchored in pixels,
        // so it would end up pointing at a base that has moved. Same reasoning
        // as closing on a scroll.
        const gone = () => onClose?.()
        window.addEventListener('resize', gone)
        return () => {
            window.removeEventListener('keydown', onKey)
            window.removeEventListener('resize', gone)
        }
    }, [onClose])

    const anchor = popup?.anchor || null
    const content = popup?.detail || popup?.pending || popup?.error
    useLayoutEffect(() => {
        const panel = panelRef.current
        if (!panel || !anchor) return
        // Measured rather than guessed: the box is as tall as the annotation
        // happens to be, which is one gene at this base and eleven isoforms at
        // the next.
        setPlace(placePopup({
            anchor,
            panelWidth: PANEL_W,
            panelHeight: panel.offsetHeight,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
        }))
        // `content` is in here so that the box is measured again once the answer
        // has arrived and it is no longer one line of "Looking this base up",
        // and `expanded` so that unfolding a gene's isoforms re-places it.
    }, [anchor, content, expanded])

    if (!popup) return null

    const { coord, detail, pending, error } = popup
    // Placed once here for the first paint and again from the layout effect
    // above once the box's own height is known.
    const at = place || placePopup({
        anchor, panelWidth: PANEL_W, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
    })
    const goLeft = at.side === 'left'

    const copy = async (text) => {
        try {
            if (!navigator?.clipboard?.writeText) {
                setCopied('Clipboard unavailable')
                return
            }
            await navigator.clipboard.writeText(text)
            setCopied('Copied')
        } catch {
            setCopied('Copy failed')
        }
    }

    const genes = detail?.genes || []
    // What the answer is about. A box opened at a transcript describes that
    // transcript; the genes below it are context, not switches.
    const level = detail?.level || 'location'

    return (
        <div
            ref={panelRef}
            data-sequence-base-popup="true"
            className="fixed z-40 rounded-lg shadow-xl text-[12px] leading-relaxed"
            style={{
                left: at.left,
                top: at.top,
                // Before the first measurement it is centred on the base, which
                // is right whenever it fits -- so it does not jump on opening.
                transform: at.measured ? 'none' : 'translateY(-50%)',
                visibility: at.measured ? 'visible' : 'hidden',
                width: PANEL_W,
                maxHeight: '70vh',
                overflowY: 'auto',
                backgroundColor: PANEL_BG,
                color: '#f1f5f9',
                padding: '10px 14px',
                border: '1px solid rgba(255,255,255,0.1)',
                pointerEvents: 'auto',
                overflowWrap: 'break-word',
            }}
            onPointerDown={(event) => event.stopPropagation()}
        >
            {/* A square on its corner rather than the usual bordered-triangle
                trick. The triangle has no outline of its own, and this box is
                dark against a dark page: over the sequence its point simply
                disappeared, which defeats the purpose of having one. A rotated
                square takes the panel's own border on its two outer sides, so
                the point is drawn in the same line as the rest of the box. Its
                inner half is hidden under the panel. */}
            <div style={{
                position: 'absolute',
                top: at.measured ? at.arrow : '50%',
                [goLeft ? 'right' : 'left']: -DIAMOND / 2,
                width: DIAMOND,
                height: DIAMOND,
                transform: 'translateY(-50%) rotate(45deg)',
                backgroundColor: PANEL_BG,
                borderLeft: goLeft ? 'none' : POINT_EDGE,
                borderBottom: goLeft ? 'none' : POINT_EDGE,
                borderRight: goLeft ? POINT_EDGE : 'none',
                borderTop: goLeft ? POINT_EDGE : 'none',
            }} />

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ fontWeight: 700, fontSize: 13, fontFamily: FONT_MONO }}>
                    {chrom}:{groupDigits(coord)}
                </span>
                {detail?.base ? (
                    <span style={{ fontFamily: FONT_MONO, opacity: 0.8 }}>{detail.base}</span>
                ) : null}
                {detail?.masked ? (
                    <span style={{ fontSize: 10, opacity: 0.6 }}>repeat</span>
                ) : null}
                <button
                    type="button"
                    title="Copy this position"
                    onClick={() => copy(`${chrom}:${coord}`)}
                    style={{
                        marginLeft: 'auto',
                        border: '1px solid rgba(255,255,255,0.14)',
                        background: 'rgba(37, 99, 235, 0.22)',
                        color: '#dbeafe',
                        borderRadius: 6,
                        padding: '1px 7px',
                        fontSize: 11,
                        cursor: 'pointer',
                    }}
                >
                    {copied || 'Copy'}
                </button>
                <button
                    type="button"
                    aria-label="Close"
                    onClick={onClose}
                    style={{
                        border: 'none', background: 'transparent', color: '#94a3b8',
                        fontSize: 15, lineHeight: 1, cursor: 'pointer', padding: 0,
                    }}
                >
                    ×
                </button>
            </div>

            {pending ? (
                <div style={{ opacity: 0.7 }}>Looking this base up&hellip;</div>
            ) : error ? (
                <div style={{ color: '#fca5a5' }}>{error}</div>
            ) : (
                <>
                    <div style={{ marginBottom: genes.length ? 8 : 0 }}>
                        <span style={{ opacity: 0.74 }}>Drawn as:</span>{' '}
                        {detail?.cls ? <ClassChip name={detail.cls} palette={palette} /> : (
                            <span style={{ fontWeight: 700 }}>Nothing here</span>
                        )}
                        {detail?.cls === 'mixed' ? (
                            <span style={{ opacity: 0.6 }}> &mdash; they disagree, below</span>
                        ) : null}
                        {level !== 'location' ? (
                            <span style={{ opacity: 0.55, fontSize: 11, display: 'block' }}>
                                {level === 'gene'
                                    ? 'by this gene, which is what the view is drawing'
                                    : 'by the transcript the view is drawing'}
                            </span>
                        ) : null}
                    </div>

                    {detail?.annotation === 'absent' ? (
                        <div style={{ opacity: 0.7 }}>
                            This genome has sequence but no annotation.
                        </div>
                    ) : genes.length === 0 ? (
                        <div style={{ opacity: 0.7 }}>No gene covers this base.</div>
                    ) : null}

                    {genes.length > 1 ? (
                        <div style={{
                            marginBottom: 6,
                            paddingBottom: 4,
                            borderBottom: '1px solid rgba(255,255,255,0.08)',
                            display: 'flex', alignItems: 'center', gap: 6,
                        }}>
                            <span style={{
                                width: 10, height: 0, flex: '0 0 auto',
                                borderBottom: `2px solid ${palette.overlap}`,
                            }} />
                            <span>{genes.length} genes cover this base</span>
                        </div>
                    ) : null}

                    {genes.map((gene) => (
                        <div key={gene.id} style={{ marginBottom: 8, opacity: gene.hidden ? 0.5 : 1 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <span style={{ fontWeight: 700 }}>{gene.name || gene.id}</span>
                                <span style={{ opacity: 0.6, fontSize: 11 }}>
                                    {strandText(gene.strand)}
                                </span>
                                {gene.biotype ? (
                                    <span style={{ opacity: 0.6, fontSize: 11 }}>
                                        {biotypeText(gene.biotype)}
                                    </span>
                                ) : null}
                                {/* Silenced from here as well as from the list:
                                    a base under two genes is exactly where a
                                    reader finds out that one of them is in the
                                    way. */}
                                {drawnHere(level, gene) ? (
                                    <EyeButton
                                        hidden={Boolean(gene.hidden)}
                                        what={`${gene.name || gene.id} and its isoforms`}
                                        onClick={() => onHiddenChange?.(geneSwitch(gene))}
                                    />
                                ) : gene.focus ? (
                                    <span style={{
                                        marginLeft: 'auto', fontSize: 10, color: '#93c5fd',
                                    }}>reading</span>
                                ) : (
                                    <SwitchButton
                                        what={gene.name || gene.id}
                                        onClick={() => onFocusGene?.(gene)}
                                    />
                                )}
                            </div>
                            {gene.name && gene.name !== gene.id ? (
                                <div style={{ fontFamily: FONT_MONO, fontSize: 11, opacity: 0.7 }}>
                                    {gene.id}
                                </div>
                            ) : null}
                            <div style={{ marginTop: 2 }}>
                                <span style={{ opacity: 0.74 }}>Here:</span>{' '}
                                {gene.hidden ? (
                                    <span style={{ fontWeight: 700 }}>Hidden &mdash; not counted</span>
                                ) : <ClassChip name={gene.cls} palette={palette} />}
                            </div>
                            {gene.transcripts.length ? (
                                <div style={{ marginTop: 3, paddingLeft: 8, borderLeft: '2px solid rgba(255,255,255,0.12)' }}>
                                    <div style={{ opacity: 0.55, fontSize: 11, marginBottom: 2 }}>
                                        {gene.transcripts.length === gene.transcript_count
                                            ? `${gene.transcripts.length} ${gene.transcripts.length === 1 ? 'isoform' : 'isoforms'} here`
                                            : `${gene.transcripts.length} of ${gene.transcript_count} isoforms here`}
                                    </div>
                                    {/* The identifier on its own line and the
                                        answer under it, rather than both on one
                                        line: an identifier, a tag, a chip and an
                                        exon number do not fit across the box, and
                                        wrapping put them in a different order for
                                        every isoform. */}
                                    {shownIsoforms(gene, expanded).map((transcript) => (
                                        <div
                                            key={transcript.id}
                                            style={{ marginBottom: 3, opacity: transcript.hidden ? 0.5 : 1 }}
                                        >
                                            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                                <span style={{ fontFamily: FONT_MONO, fontSize: 11 }}>
                                                    {transcript.id}
                                                </span>
                                                {transcript.canonical ? (
                                                    <span style={{ fontSize: 10, color: '#93c5fd' }}>canonical</span>
                                                ) : null}
                                                {transcript.biotype && transcript.biotype !== gene.biotype ? (
                                                    <span style={{ fontSize: 10, opacity: 0.55 }}>
                                                        {biotypeText(transcript.biotype)}
                                                    </span>
                                                ) : null}
                                                {drawnHere(level, gene, transcript) ? (
                                                    <EyeButton
                                                        hidden={Boolean(transcript.hidden)}
                                                        what={isoformSwitchLabel(gene, transcript)}
                                                        onClick={() => onHiddenChange?.(isoformSwitch(gene, transcript))}
                                                    />
                                                ) : transcript.focus ? (
                                                    <span style={{
                                                        marginLeft: 'auto', fontSize: 10, color: '#93c5fd',
                                                    }}>reading</span>
                                                ) : (
                                                    <SwitchButton
                                                        what={transcript.id}
                                                        onClick={() => onFocusTranscript?.(gene, transcript)}
                                                    />
                                                )}
                                            </div>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                                <ClassChip name={transcript.cls} palette={palette} />
                                                {whereIn(transcript) ? (
                                                    <span style={{ opacity: 0.6, fontSize: 11 }}>
                                                        {whereIn(transcript)}
                                                    </span>
                                                ) : null}
                                            </div>
                                        </div>
                                    ))}
                                    {gene.transcripts.length > ISOFORMS_SHOWN && !expanded.has(gene.id) ? (
                                        <button
                                            type="button"
                                            onClick={() => setExpanded((open) => new Set(open).add(gene.id))}
                                            style={{
                                                border: 'none', background: 'transparent', padding: 0,
                                                color: '#93c5fd', fontSize: 11, cursor: 'pointer',
                                            }}
                                        >
                                            {gene.transcripts.length - ISOFORMS_SHOWN} more
                                            {agreed(gene) ? `, all ${CLASS_WORDS[agreed(gene)] || agreed(gene)}` : ''}
                                        </button>
                                    ) : null}

                                </div>
                            ) : null}
                        </div>
                    ))}

                    {detail?.truncated ? (
                        <div style={{ opacity: 0.55, fontSize: 11 }}>
                            Showing {genes.length} of {detail.gene_count} genes here.
                        </div>
                    ) : null}
                </>
            )}
        </div>
    )
}

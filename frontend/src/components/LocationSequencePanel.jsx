import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { API_BASE } from '../backendRuntime'
import { FOCUS_DETAIL_WIDTH } from './FocusTranscriptDetail'
import {
    SEQUENCE_BLOCK_BP,
    locationFasta,
    locationFastaHeader,
    locationSpan,
    reverseComplement,
    sequenceBlock,
    sequenceChunks,
    wrapSequence,
} from '../utils/locationFocus'

// Lines the box shows while it is a preview. Enough to see what the sequence
// looks like; short enough that the sections under it stay on screen.
const PREVIEW_LINES = 12

// Room the expanded box leaves for everything above it — the region block, the
// section headings, the strand and block controls.
const SEQUENCE_BOX_CHROME_PX = 250

// Floor for the expanded box, for the case where the panel is shorter than the
// chrome plus this. Below it the box stops being a sequence view.
const SEQUENCE_BOX_MIN_PX = 220

// Lines added each time an expanded box is scrolled to its end. A megabase is
// some sixteen thousand lines and the DOM does not need them all at once.
const LINE_PAGE = 240

function CloseGlyph({ size = 15 }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
        </svg>
    )
}

function CopyGlyph({ size = 13 }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="9" y="9" width="11" height="11" rx="2" />
            <path d="M5 15V5a2 2 0 0 1 2-2h10" />
        </svg>
    )
}

function StepGlyph({ back = false, size = 14 }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points={back ? '15 6 9 12 15 18' : '9 6 15 12 9 18'} />
        </svg>
    )
}

const formatNumber = (value) => (
    Number.isFinite(Number(value)) ? Math.round(Number(value)).toLocaleString() : '—'
)

// Labels and values each start on their own left edge, so the eye runs down two
// straight columns — the same two the transcript detail draws.
function Field({ label, labelClass, valueClass, children }) {
    return (
        <div className="flex items-start gap-2 text-[11px] leading-[1.5]">
            <span className={`flex-none w-[86px] text-left ${labelClass}`}>{label}</span>
            <span className={`min-w-0 flex-1 text-left ${valueClass}`}>{children}</span>
        </div>
    )
}

/**
 * Fetch one range as a single string, in chunks the endpoint will accept.
 *
 * Sequential rather than parallel: a megabase is ten requests off local disk,
 * and ten at once only competes with the tiles the browser itself is fetching.
 */
async function fetchSequenceRange({ genome, chrom, start, end, signal, onProgress = null }) {
    const chunks = sequenceChunks(start, end)
    const parts = []
    for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index]
        const params = new URLSearchParams({
            genome,
            chrom,
            start: String(chunk.start),
            end: String(chunk.end),
        })
        const res = await fetch(`${API_BASE}/api/browse/sequence?${params.toString()}`, { signal })
        const payload = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(payload?.detail || 'Could not read the sequence for this region.')
        parts.push(String(payload?.sequence || ''))
        onProgress?.((index + 1) / chunks.length)
    }
    return parts.join('')
}

/**
 * The sequence of the location of focus, opened from the drawer's Location
 * section — the location's answer to the gene drawer's transcript detail.
 *
 * A focused location can be a whole chromosome, so the box reads the region one
 * block at a time and the reader steps between blocks. Copying is not bounded
 * that way: the copy button walks the whole region however long it is, which is
 * the one operation where waiting is worth it.
 */
export default function LocationSequencePanel({
    theme = 'dark',
    genome = 'reference',
    genomeLabel = '',
    location = null,
    onClose = null,
    onCopyFeedback = null,
}) {
    const isLight = theme === 'light'
    const [reverse, setReverse] = useState(false)
    const [blockIndex, setBlockIndex] = useState(0)
    const [state, setState] = useState({ status: 'idle', sequence: '', error: '' })
    const [expanded, setExpanded] = useState(false)
    const [visibleLines, setVisibleLines] = useState(LINE_PAGE)
    const [copyState, setCopyState] = useState({ busy: false, progress: 0, label: '' })
    const requestRef = useRef(0)
    const copyAbortRef = useRef(null)
    const rootRef = useRef(null)
    // The panel is as tall as the drawer it sits in, and the drawer grows its
    // panel to fit. Measured rather than fixed so the expanded sequence box uses
    // whatever height that negotiation ends up giving it.
    const [panelHeight, setPanelHeight] = useState(0)

    const span = useMemo(() => locationSpan(location), [location])
    const chrom = String(location?.chrom || '')
    const block = useMemo(() => sequenceBlock(location, blockIndex), [location, blockIndex])

    // A new location is a new region to read, from its first block.
    const locationKey = `${chrom}:${span?.start ?? ''}-${span?.end ?? ''}`
    useEffect(() => {
        setBlockIndex(0)
        setExpanded(false)
    }, [locationKey])

    useEffect(() => {
        if (!chrom || !block) {
            setState({ status: 'idle', sequence: '', error: '' })
            return undefined
        }
        const token = requestRef.current + 1
        requestRef.current = token
        const controller = new AbortController()
        setState({ status: 'loading', sequence: '', error: '' })
        setVisibleLines(LINE_PAGE)

        ;(async () => {
            try {
                const sequence = await fetchSequenceRange({
                    genome,
                    chrom,
                    start: block.start,
                    end: block.end,
                    signal: controller.signal,
                })
                if (requestRef.current !== token) return
                setState({ status: 'done', sequence, error: '' })
            } catch (error) {
                if (controller.signal.aborted || requestRef.current !== token) return
                setState({ status: 'error', sequence: '', error: error?.message || 'Could not read the sequence.' })
            }
        })()

        return () => controller.abort()
    }, [genome, chrom, block?.start, block?.end]) // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => () => copyAbortRef.current?.abort(), [])

    useEffect(() => {
        const node = rootRef.current
        if (!node) return undefined
        const measure = () => setPanelHeight(Math.round(node.getBoundingClientRect().height))
        measure()
        const observer = new ResizeObserver(measure)
        observer.observe(node)
        return () => observer.disconnect()
    }, [])

    // The strand is applied to what is on screen. Reading a region backwards
    // block by block would put the blocks themselves in the wrong order, so the
    // header names the block's own coordinates either way and the copy below
    // reverses the whole region in one piece.
    const shownSequence = useMemo(
        () => (reverse ? reverseComplement(state.sequence) : state.sequence),
        [reverse, state.sequence]
    )
    const header = useMemo(() => locationFastaHeader({
        chrom,
        start: block?.start,
        end: block?.end,
        reverse,
        genome: genomeLabel,
    }), [chrom, block?.start, block?.end, reverse, genomeLabel])

    const lines = useMemo(() => {
        const wrapped = wrapSequence(shownSequence)
        return wrapped ? wrapped.split('\n') : []
    }, [shownSequence])

    const shownLines = useMemo(
        () => (expanded ? lines.slice(0, visibleLines) : lines.slice(0, PREVIEW_LINES)),
        [expanded, lines, visibleLines]
    )
    const hiddenLineCount = Math.max(0, lines.length - shownLines.length)

    const handleCopyBlock = useCallback(async () => {
        const payload = locationFasta({
            chrom,
            start: block?.start,
            end: block?.end,
            sequence: shownSequence,
            reverse,
            genome: genomeLabel,
        })
        if (!payload) return
        try {
            await navigator.clipboard.writeText(payload)
            setCopyState({ busy: false, progress: 0, label: 'Copied' })
            onCopyFeedback?.('Copied')
        } catch {
            setCopyState({ busy: false, progress: 0, label: 'Copy failed' })
            onCopyFeedback?.('Copy failed')
        }
    }, [chrom, block?.start, block?.end, shownSequence, reverse, genomeLabel, onCopyFeedback])

    /* The whole region, however long — the reader asked for all of it, so this
     * fetches every block rather than what happens to be on screen. */
    const handleCopyRegion = useCallback(async () => {
        if (!span || !chrom || copyState.busy) return
        copyAbortRef.current?.abort()
        const controller = new AbortController()
        copyAbortRef.current = controller
        setCopyState({ busy: true, progress: 0, label: '' })
        try {
            const sequence = await fetchSequenceRange({
                genome,
                chrom,
                start: span.start,
                end: span.end,
                signal: controller.signal,
                onProgress: (fraction) => setCopyState({ busy: true, progress: fraction, label: '' }),
            })
            const payload = locationFasta({
                chrom,
                start: span.start,
                end: span.end,
                sequence: reverse ? reverseComplement(sequence) : sequence,
                reverse,
                genome: genomeLabel,
            })
            await navigator.clipboard.writeText(payload)
            setCopyState({ busy: false, progress: 0, label: 'Whole region copied' })
            onCopyFeedback?.('Copied')
        } catch {
            if (controller.signal.aborted) {
                setCopyState({ busy: false, progress: 0, label: '' })
                return
            }
            setCopyState({ busy: false, progress: 0, label: 'Copy failed' })
            onCopyFeedback?.('Copy failed')
        }
    }, [span, chrom, genome, genomeLabel, reverse, copyState.busy, onCopyFeedback])

    useEffect(() => {
        if (!copyState.label) return undefined
        const timer = setTimeout(() => setCopyState((prev) => ({ ...prev, label: '' })), 1800)
        return () => clearTimeout(timer)
    }, [copyState.label])

    // --- Styling -------------------------------------------------------------

    const textClass = isLight ? 'text-gray-800' : 'text-gray-200'
    const subTextClass = isLight ? 'text-gray-500' : 'text-gray-400'
    const dividerColor = isLight ? '#e5e7eb' : '#374151'
    const accentColor = isLight ? '#0099ff' : '#4c9aff'
    const seqBg = isLight ? '#f8fafc' : '#161d29'
    const rowHoverClass = isLight ? 'hover:bg-gray-100' : 'hover:bg-[#273449]'

    if (!location || !span) return null

    const strandButton = (value, label, title) => (
        <button
            type="button"
            onClick={() => setReverse(value)}
            aria-pressed={reverse === value}
            title={title}
            className={`px-2 py-0.5 rounded text-[10px] transition-colors ${rowHoverClass}`}
            style={{
                backgroundColor: reverse === value ? accentColor : undefined,
                color: reverse === value ? '#ffffff' : undefined,
            }}
        >
            {label}
        </button>
    )

    return (
        <div
            ref={rootRef}
            className="flex flex-col h-full min-h-0 overflow-hidden border-l"
            style={{ width: FOCUS_DETAIL_WIDTH, borderColor: dividerColor }}
            data-location-sequence-panel="true"
        >
            <div className="flex-1 min-h-0 overflow-y-auto themed-scrollbar px-3 py-2.5 flex flex-col gap-2.5">
                <section className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                        <h3 className={`text-[11px] font-semibold tracking-wide uppercase ${subTextClass}`}>Location</h3>
                        <div className="flex-1 h-px" style={{ backgroundColor: dividerColor }} />
                        <button
                            type="button"
                            data-tour-id="location-sequence-close"
                            onClick={() => onClose?.()}
                            className={`flex-none p-1 rounded transition-colors ${rowHoverClass}`}
                            style={{ color: accentColor }}
                            title="Close the location sequence"
                        >
                            <CloseGlyph />
                        </button>
                    </div>
                    <Field labelClass={subTextClass} valueClass={textClass} label="Region">
                        <span className="font-mono font-semibold">
                            {chrom}:{formatNumber(span.start + 1)}-{formatNumber(span.end)}
                        </span>
                    </Field>
                    <Field labelClass={subTextClass} valueClass={textClass} label="Length">{formatNumber(span.length)} bp</Field>
                    {genomeLabel && <Field labelClass={subTextClass} valueClass={textClass} label="Genome">{genomeLabel}</Field>}
                </section>

                <section className="flex flex-col gap-1.5 flex-1 min-h-0">
                    <div className="flex items-center gap-2 flex-wrap">
                        <h3 className={`text-[11px] font-semibold tracking-wide uppercase ${subTextClass}`}>Sequence</h3>
                        <div className="flex-1 h-px min-w-[12px]" style={{ backgroundColor: dividerColor }} />
                        <div className="flex-none flex items-center gap-1" data-tour-id="location-sequence-strand">
                            {strandButton(false, 'Forward', 'Show the forward strand')}
                            {strandButton(true, 'Reverse', 'Show the reverse complement')}
                        </div>
                        <button
                            type="button"
                            data-tour-id="location-sequence-copy"
                            onClick={handleCopyBlock}
                            disabled={state.status !== 'done' || !shownSequence}
                            title={block?.isWhole
                                ? 'Copy this sequence as FASTA'
                                : 'Copy the block on screen as FASTA'}
                            className={`flex-none flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] transition-colors ${rowHoverClass} disabled:opacity-40`}
                            style={{ color: accentColor }}
                        >
                            <CopyGlyph />
                            Copy
                        </button>
                    </div>

                    {!block?.isWhole && (
                        <div className="flex items-center gap-1.5">
                            <button
                                type="button"
                                onClick={() => setBlockIndex((prev) => Math.max(0, prev - 1))}
                                disabled={block.index === 0}
                                title="Previous block"
                                className={`flex-none p-0.5 rounded transition-colors ${rowHoverClass} disabled:opacity-30`}
                                style={{ color: accentColor }}
                            >
                                <StepGlyph back />
                            </button>
                            <span className={`text-[10px] tabular-nums ${subTextClass}`}>
                                Block {block.index + 1} of {block.count} ·{' '}
                                <span className="font-mono">
                                    {formatNumber(block.start + 1)}-{formatNumber(block.end)}
                                </span>
                            </span>
                            <button
                                type="button"
                                onClick={() => setBlockIndex((prev) => Math.min(block.count - 1, prev + 1))}
                                disabled={block.index >= block.count - 1}
                                title="Next block"
                                className={`flex-none p-0.5 rounded transition-colors ${rowHoverClass} disabled:opacity-30`}
                                style={{ color: accentColor }}
                            >
                                <StepGlyph />
                            </button>
                            <button
                                type="button"
                                data-tour-id="location-sequence-copy-all"
                                onClick={handleCopyRegion}
                                disabled={copyState.busy}
                                title={`Copy all ${formatNumber(span.length)} bp to the clipboard`}
                                className={`ml-auto flex-none flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] transition-colors ${rowHoverClass} disabled:opacity-60`}
                                style={{ color: accentColor }}
                            >
                                <CopyGlyph />
                                {copyState.busy
                                    ? `Reading ${Math.round(copyState.progress * 100)}%`
                                    : 'Copy whole region'}
                            </button>
                        </div>
                    )}

                    {copyState.label && (
                        <div className={`text-[10px] ${subTextClass}`}>{copyState.label}</div>
                    )}

                    <div
                        className="relative rounded border overflow-hidden"
                        style={{ backgroundColor: seqBg, borderColor: dividerColor }}
                    >
                        <div
                            className="overflow-auto themed-scrollbar"
                            style={{
                                maxHeight: expanded
                                    ? Math.max(SEQUENCE_BOX_MIN_PX, panelHeight - SEQUENCE_BOX_CHROME_PX)
                                    : undefined,
                            }}
                            onScroll={(event) => {
                                if (!expanded) return
                                const el = event.currentTarget
                                if (el.scrollTop + el.clientHeight < el.scrollHeight - 40) return
                                setVisibleLines((prev) => (prev >= lines.length ? prev : prev + LINE_PAGE))
                            }}
                        >
                            {state.status === 'loading' && (
                                <div className={`px-2 py-2 text-[11px] ${subTextClass}`}>Reading sequence…</div>
                            )}
                            {state.status === 'error' && (
                                <div className="px-2 py-2 text-[11px] text-red-400">{state.error}</div>
                            )}
                            {state.status === 'done' && lines.length === 0 && (
                                <div className={`px-2 py-2 text-[11px] ${subTextClass}`}>No sequence for this region.</div>
                            )}
                            {state.status === 'done' && lines.length > 0 && (
                                <pre
                                    className={`px-2 py-1.5 text-[10.5px] leading-[1.45] font-mono whitespace-pre ${textClass}`}
                                    // Room for the preview's own message, which is laid
                                    // over the foot of the box — without it the last line
                                    // of a preview reads through the gradient.
                                    style={{ paddingBottom: !expanded && hiddenLineCount > 0 ? 26 : undefined }}
                                >
                                    <span style={{ color: accentColor }}>{header}{'\n'}</span>
                                    {shownLines.map((line, index) => (
                                        <span key={index}>{line}{'\n'}</span>
                                    ))}
                                    {expanded && hiddenLineCount > 0 && (
                                        <span className={subTextClass}>
                                            {`… ${formatNumber(hiddenLineCount)} more lines, scroll to load\n`}
                                        </span>
                                    )}
                                </pre>
                            )}
                        </div>

                        {/* The preview says what it is hiding and is itself the
                            control that stops hiding it — a separate button would
                            sit below the fold on a short panel. */}
                        {state.status === 'done' && !expanded && hiddenLineCount > 0 && (
                            <button
                                type="button"
                                data-tour-id="location-sequence-expand"
                                onClick={() => { setExpanded(true); setVisibleLines(LINE_PAGE) }}
                                className="absolute inset-x-0 bottom-0 px-2 py-1 text-[10px] text-left transition-opacity hover:opacity-90"
                                style={{
                                    color: accentColor,
                                    backgroundImage: `linear-gradient(to bottom, transparent, ${seqBg} 55%)`,
                                }}
                            >
                                Preview of {formatNumber(block.length)} bp — click to show the whole
                                {block.isWhole ? ' sequence' : ' block'}
                            </button>
                        )}
                    </div>

                    {state.status === 'done' && expanded && (
                        <button
                            type="button"
                            onClick={() => setExpanded(false)}
                            className={`self-start text-[10px] transition-opacity hover:opacity-85`}
                            style={{ color: accentColor }}
                        >
                            Back to preview
                        </button>
                    )}

                    {block?.isWhole && (
                        <button
                            type="button"
                            data-tour-id="location-sequence-copy-all"
                            onClick={handleCopyRegion}
                            disabled={copyState.busy}
                            className={`self-start flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] transition-colors ${rowHoverClass} disabled:opacity-60`}
                            style={{ color: accentColor }}
                            title={`Copy all ${formatNumber(span.length)} bp to the clipboard`}
                        >
                            <CopyGlyph />
                            {copyState.busy
                                ? `Reading ${Math.round(copyState.progress * 100)}%`
                                : 'Copy whole region'}
                        </button>
                    )}

                    {span.length > SEQUENCE_BLOCK_BP && (
                        <p className={`text-[10px] leading-[1.45] ${subTextClass}`}>
                            {formatNumber(span.length)} bp is read {formatNumber(SEQUENCE_BLOCK_BP)} bp at a time.
                            Copying the whole region reads all of it, which takes a moment.
                        </p>
                    )}
                </section>
            </div>
        </div>
    )
}

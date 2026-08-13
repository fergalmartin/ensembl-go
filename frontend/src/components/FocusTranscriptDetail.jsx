import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { API_BASE } from '../backendRuntime'
import {
    SEQUENCE_FEATURE_TYPES,
    computeTranscriptMetadata,
    getTranscriptFeatureAvailability,
} from '../utils/transcriptSequenceFeatures'

// Wide enough that a 60-character FASTA line fits without wrapping or
// horizontal scrolling, once the type selector and padding are accounted for.
export const FOCUS_DETAIL_WIDTH = 540

/** Lines rendered before the reader asks for more. A whole gene's genomic
 *  sequence runs to thousands of them, and the DOM does not need all of it. */
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

const formatNumber = (value) => (
    Number.isFinite(Number(value)) ? Number(value).toLocaleString() : '—'
)

const formatLocation = (feature) => {
    const chrom = String(feature?.chrom || '').trim()
    const start = Number(feature?.start)
    const end = Number(feature?.end)
    if (!chrom || !Number.isFinite(start) || !Number.isFinite(end)) return ''
    return `${chrom}:${start.toLocaleString()}-${end.toLocaleString()}`
}

/**
 * Metadata and sequences for one transcript, opened from the focus drawer.
 *
 * Sequences come from /api/feature_explorer/transcript_sequences, which shares
 * its record extractor with the Feature Explorer's FASTA export — so what is
 * shown here and what an export writes are the same bytes, headers included.
 */
export default function FocusTranscriptDetail({
    theme = 'dark',
    genome = 'reference',
    gene = null,
    transcript = null,
    onClose = null,
    onCopyFeedback = null,
}) {
    const isLight = theme === 'light'
    const [featureType, setFeatureType] = useState('genomic')
    const [reverseComplement, setReverseComplement] = useState(false)
    const [state, setState] = useState({ status: 'idle', records: [], error: '' })
    const [visibleLines, setVisibleLines] = useState(LINE_PAGE)
    const [copied, setCopied] = useState('')
    const requestRef = useRef(0)

    const transcriptId = String(transcript?.id || '')
    const geneId = String(gene?.id || '')

    const availability = useMemo(
        () => getTranscriptFeatureAvailability(transcript),
        [transcript]
    )
    const metadata = useMemo(
        () => computeTranscriptMetadata(transcript),
        [transcript]
    )

    // A transcript that cannot offer the selected type (switching from a coding
    // transcript to a retained intron, say) falls back rather than showing an
    // empty panel.
    useEffect(() => {
        if (availability[featureType]) return
        const fallback = SEQUENCE_FEATURE_TYPES.find((f) => availability[f.key])
        if (fallback) setFeatureType(fallback.key)
    }, [availability, featureType])

    useEffect(() => {
        if (!transcriptId || !availability[featureType]) {
            setState({ status: 'idle', records: [], error: '' })
            return undefined
        }
        const token = requestRef.current + 1
        requestRef.current = token
        let cancelled = false
        setState({ status: 'loading', records: [], error: '' })
        setVisibleLines(LINE_PAGE)

        const controller = new AbortController()
        ;(async () => {
            try {
                const res = await fetch(`${API_BASE}/api/feature_explorer/transcript_sequences`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        genome,
                        gene_id: geneId,
                        transcript_id: transcriptId,
                        feature_types: [featureType],
                        reverse_complement: reverseComplement,
                    }),
                    signal: controller.signal,
                })
                const payload = await res.json().catch(() => ({}))
                if (cancelled || requestRef.current !== token) return
                if (!res.ok) throw new Error(payload?.detail || 'Failed to fetch sequence')
                setState({ status: 'done', records: payload?.records || [], error: '' })
            } catch (error) {
                if (cancelled || controller.signal.aborted) return
                setState({ status: 'error', records: [], error: error?.message || 'Failed to fetch sequence' })
            }
        })()

        return () => {
            cancelled = true
            controller.abort()
        }
    }, [genome, geneId, transcriptId, featureType, reverseComplement, availability])

    // One text block for the whole selection, so copying gives a valid FASTA
    // file whether the type yields one record or twenty-seven.
    const fastaText = useMemo(() => (
        state.records.map((record) => `${record.header}\n${record.sequence}`).join('\n')
    ), [state.records])

    const lines = useMemo(() => (fastaText ? fastaText.split('\n') : []), [fastaText])
    const shownLines = useMemo(() => lines.slice(0, visibleLines), [lines, visibleLines])

    const totalLength = useMemo(
        () => state.records.reduce((sum, record) => sum + Number(record.length || 0), 0),
        [state.records]
    )
    const unit = state.records[0]?.unit || 'bp'

    const handleCopy = useCallback(async (value, label) => {
        const payload = String(value || '')
        if (!payload) return
        try {
            await navigator.clipboard.writeText(payload)
            setCopied(label)
            onCopyFeedback?.('Copied')
        } catch {
            setCopied('')
            onCopyFeedback?.('Copy failed')
        }
    }, [onCopyFeedback])

    useEffect(() => {
        if (!copied) return undefined
        const timer = setTimeout(() => setCopied(''), 1400)
        return () => clearTimeout(timer)
    }, [copied])

    // --- Styling -------------------------------------------------------------

    const textClass = isLight ? 'text-gray-800' : 'text-gray-200'
    const subTextClass = isLight ? 'text-gray-500' : 'text-gray-400'
    const dividerColor = isLight ? '#e5e7eb' : '#374151'
    const accentColor = isLight ? '#0099ff' : '#4c9aff'
    const seqBg = isLight ? '#f8fafc' : '#161d29'
    const rowHoverClass = isLight ? 'hover:bg-gray-100' : 'hover:bg-[#273449]'

    // Labels and values both start on their own left edge, so the eye runs down
    // two straight columns rather than tracking a ragged gutter between them.
    const Field = ({ label, children }) => (
        <div className="flex items-start gap-2 text-[11px] leading-[1.5]">
            <span className={`flex-none w-[86px] text-left ${subTextClass}`}>{label}</span>
            <span className={`min-w-0 flex-1 text-left ${textClass}`}>{children}</span>
        </div>
    )

    if (!transcript) return null

    const geneLocation = formatLocation(gene)
    const transcriptLocation = formatLocation(transcript)
    // Strand belongs to the gene; repeating it on every transcript said nothing
    // the block above had not already said.
    const geneStrandLabel = String(gene?.strand || transcript.strand || '+') === '+'
        ? 'forward strand'
        : 'reverse strand'
    const geneStart = Number(gene?.start)
    const geneEnd = Number(gene?.end)
    const geneLength = (Number.isFinite(geneStart) && Number.isFinite(geneEnd) && geneEnd >= geneStart)
        ? (geneEnd - geneStart) + 1
        : 0

    return (
        <div
            className="flex flex-col h-full min-h-0 overflow-hidden border-l"
            style={{ width: FOCUS_DETAIL_WIDTH, borderColor: dividerColor }}
            data-focus-transcript-detail={transcriptId}
        >
            <div className="flex-1 min-h-0 overflow-y-auto themed-scrollbar px-3 py-2.5 flex flex-col gap-2.5">
                {/* Gene first: the transcript below only means anything in its terms. */}
                <section className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                        <h3 className={`text-[11px] font-semibold tracking-wide uppercase ${subTextClass}`}>Gene</h3>
                        <div className="flex-1 h-px" style={{ backgroundColor: dividerColor }} />
                        <button
                            type="button"
                            onClick={() => onClose?.()}
                            className={`flex-none p-1 rounded transition-colors ${rowHoverClass}`}
                            style={{ color: accentColor }}
                            title="Close transcript details"
                        >
                            <CloseGlyph />
                        </button>
                    </div>
                    <Field label="Symbol">
                        <span className="font-semibold">{gene?.name || gene?.id || '—'}</span>
                    </Field>
                    <Field label="Gene ID">
                        <span className="font-mono">{geneId || '—'}</span>
                        {geneId && (
                            <button
                                type="button"
                                onClick={() => handleCopy(geneId, 'gene')}
                                title="Copy gene ID"
                                className="ml-1.5 align-middle opacity-80 hover:opacity-100 transition-opacity"
                                style={{ color: accentColor }}
                            >
                                <CopyGlyph />
                            </button>
                        )}
                        {copied === 'gene' && <span className={`ml-1.5 text-[10px] ${subTextClass}`}>Copied</span>}
                    </Field>
                    <Field label="Biotype">{gene?.biotype || '—'}</Field>
                    {geneLocation && <Field label="Location">{geneLocation}</Field>}
                    {geneLength > 0 && <Field label="Length">{formatNumber(geneLength)} bp</Field>}
                    <Field label="Strand">{geneStrandLabel}</Field>
                </section>

                <section className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                        <h3 className={`text-[11px] font-semibold tracking-wide uppercase ${subTextClass}`}>Transcript</h3>
                        <div className="flex-1 h-px" style={{ backgroundColor: dividerColor }} />
                    </div>
                    <Field label="Transcript ID">
                        <span className="font-mono font-semibold">{transcriptId}</span>
                        <button
                            type="button"
                            onClick={() => handleCopy(transcriptId, 'transcript')}
                            title="Copy transcript ID"
                            className="ml-1.5 align-middle opacity-80 hover:opacity-100 transition-opacity"
                            style={{ color: accentColor }}
                        >
                            <CopyGlyph />
                        </button>
                        {copied === 'transcript' && <span className={`ml-1.5 text-[10px] ${subTextClass}`}>Copied</span>}
                    </Field>
                    <Field label="Biotype">{transcript.biotype || '—'}</Field>
                    {transcriptLocation && <Field label="Location">{transcriptLocation}</Field>}
                    <Field label="Length">
                        {formatNumber(metadata.transcriptLength)} bp · {formatNumber(metadata.exonCount)} exons
                    </Field>
                    {metadata.hasCds && (
                        <>
                            <Field label="CDS">
                                {formatNumber(metadata.cdsLength)} bp · {formatNumber(metadata.cdsExonCount)} coding exons
                            </Field>
                            <Field label="Protein">{formatNumber(metadata.translationLength)} aa</Field>
                            <Field label="UTR">
                                5′ {formatNumber(metadata.fivePrimeUtrLength)} bp · 3′ {formatNumber(metadata.threePrimeUtrLength)} bp
                            </Field>
                        </>
                    )}
                </section>

                {/* Sequences last and already open: this is what the extra width is
                    for, so it should never be the thing the reader has to go find. */}
                <section className="flex flex-col gap-1.5 flex-1 min-h-0">
                    <div className="flex items-center gap-2">
                        <h3 className={`text-[11px] font-semibold tracking-wide uppercase ${subTextClass}`}>Sequence</h3>
                        <div className="flex-1 h-px" style={{ backgroundColor: dividerColor }} />
                        {state.status === 'done' && state.records.length > 0 && (
                            <span className={`flex-none text-[10px] ${subTextClass}`}>
                                {formatNumber(totalLength)} {unit}
                                {state.records.length > 1 ? ` · ${state.records.length} records` : ''}
                            </span>
                        )}
                        {/* In the header rather than under the type list: at the
                            foot of a short window that column runs to the bottom
                            edge and the control ends up half off-screen. */}
                        <label
                            className={`flex-none flex items-center gap-1 text-[10px] ${featureType === 'protein' ? 'opacity-40' : ''} ${subTextClass}`}
                            title={featureType === 'protein'
                                ? 'Amino acids have no complement'
                                : 'Show the reverse complement'}
                        >
                            <input
                                type="checkbox"
                                className="w-3 h-3"
                                checked={reverseComplement && featureType !== 'protein'}
                                disabled={featureType === 'protein'}
                                onChange={(event) => setReverseComplement(event.target.checked)}
                            />
                            Rev. comp.
                        </label>
                        <button
                            type="button"
                            onClick={() => handleCopy(fastaText, 'fasta')}
                            disabled={!fastaText}
                            title="Copy FASTA"
                            className={`flex-none flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] transition-colors ${rowHoverClass} disabled:opacity-40`}
                            style={{ color: accentColor }}
                        >
                            <CopyGlyph />
                            {copied === 'fasta' ? 'Copied' : 'Copy'}
                        </button>
                    </div>

                    <div className="flex gap-2 min-h-0 flex-1">
                        <div
                            className="flex-1 min-w-0 overflow-auto themed-scrollbar rounded border"
                            style={{ backgroundColor: seqBg, borderColor: dividerColor, minHeight: 200 }}
                            onScroll={(event) => {
                                const el = event.currentTarget
                                if (el.scrollTop + el.clientHeight < el.scrollHeight - 40) return
                                setVisibleLines((prev) => (prev >= lines.length ? prev : prev + LINE_PAGE))
                            }}
                        >
                            {state.status === 'loading' && (
                                <div className={`px-2 py-2 text-[11px] ${subTextClass}`}>Loading sequence…</div>
                            )}
                            {state.status === 'error' && (
                                <div className="px-2 py-2 text-[11px] text-red-400">{state.error}</div>
                            )}
                            {state.status === 'done' && lines.length === 0 && (
                                <div className={`px-2 py-2 text-[11px] ${subTextClass}`}>No sequence available.</div>
                            )}
                            {state.status === 'done' && lines.length > 0 && (
                                <pre className={`px-2 py-1.5 text-[10.5px] leading-[1.45] font-mono whitespace-pre ${textClass}`}>
                                    {shownLines.map((line, index) => (
                                        line.startsWith('>')
                                            ? <span key={index} style={{ color: accentColor }}>{line}{'\n'}</span>
                                            : <span key={index}>{line}{'\n'}</span>
                                    ))}
                                    {visibleLines < lines.length && (
                                        <span className={subTextClass}>
                                            {`… ${formatNumber(lines.length - visibleLines)} more lines, scroll to load\n`}
                                        </span>
                                    )}
                                </pre>
                            )}
                        </div>

                        <div className="flex-none w-[104px] flex flex-col gap-0.5">
                            {SEQUENCE_FEATURE_TYPES.map((feature) => {
                                const enabled = Boolean(availability[feature.key])
                                const active = featureType === feature.key
                                return (
                                    <button
                                        key={feature.key}
                                        type="button"
                                        disabled={!enabled}
                                        onClick={() => setFeatureType(feature.key)}
                                        title={enabled ? `Show ${feature.label}` : `No ${feature.label} for this transcript`}
                                        className={`text-left px-2 py-1 rounded text-[11px] transition-colors ${enabled ? rowHoverClass : ''}`}
                                        style={{
                                            color: !enabled
                                                ? (isLight ? '#c7ccd1' : '#5c5f66')
                                                : active ? '#ffffff' : undefined,
                                            backgroundColor: active && enabled ? accentColor : undefined,
                                            cursor: enabled ? 'pointer' : 'not-allowed',
                                        }}
                                    >
                                        {feature.label}
                                    </button>
                                )
                            })}
                        </div>
                    </div>
                </section>
            </div>
        </div>
    )
}

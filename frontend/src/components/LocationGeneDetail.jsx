import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { API_BASE } from '../backendRuntime'
import { FOCUS_DETAIL_WIDTH } from './FocusTranscriptDetail'
import { computeTranscriptMetadata } from '../utils/transcriptSequenceFeatures'

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
    Number.isFinite(Number(value)) ? Math.round(Number(value)).toLocaleString() : '—'
)

// The same two-column field the sequence panel and the transcript detail draw.
function Field({ label, labelClass, valueClass, children }) {
    return (
        <div className="flex items-start gap-2 text-[11px] leading-[1.5]">
            <span className={`flex-none w-[86px] text-left ${labelClass}`}>{label}</span>
            <span className={`min-w-0 flex-1 text-left ${valueClass}`}>{children}</span>
        </div>
    )
}

/** The same badge rule the gene drawer's transcript list uses. */
function transcriptBadges(transcript) {
    const tags = (Array.isArray(transcript?.tags) ? transcript.tags : [])
        .map((tag) => String(tag).toLowerCase().replace(/[\s-]+/g, '_'))
    return {
        canonical: Boolean(transcript?.is_canonical) || tags.includes('ensembl_canonical'),
        maneSelect: tags.some((tag) => tag.includes('mane') && tag.includes('select')),
    }
}

/**
 * One gene from the location drawer's feature list, in the drawer's wide slot.
 *
 * The gene's own metadata, then every transcript it has with the few numbers
 * worth reading at a glance. Deliberately not the focus drawer's transcript
 * detail: nothing here is about the gene of focus, and picking a transcript
 * apart is what focusing the gene is for.
 */
export default function LocationGeneDetail({
    theme = 'dark',
    genome = 'reference',
    gene = null,
    onClose = null,
    onFocusGene = null,
    onCopyFeedback = null,
}) {
    const isLight = theme === 'light'
    const [state, setState] = useState({ status: 'idle', transcripts: [], error: '' })
    const [copied, setCopied] = useState('')
    const requestRef = useRef(0)

    const geneId = String(gene?.id || '')

    useEffect(() => {
        if (!geneId) {
            setState({ status: 'idle', transcripts: [], error: '' })
            return undefined
        }
        const token = requestRef.current + 1
        requestRef.current = token
        const controller = new AbortController()
        setState({ status: 'loading', transcripts: [], error: '' })

        ;(async () => {
            try {
                const params = new URLSearchParams({ genome, gene_id: geneId, include_tags_fallback: 'true' })
                const res = await fetch(`${API_BASE}/api/browse/transcripts?${params.toString()}`, {
                    signal: controller.signal,
                })
                const payload = await res.json().catch(() => ([]))
                if (requestRef.current !== token) return
                if (!res.ok) throw new Error(payload?.detail || 'Could not load transcripts.')
                setState({ status: 'done', transcripts: Array.isArray(payload) ? payload : [], error: '' })
            } catch (error) {
                if (controller.signal.aborted || requestRef.current !== token) return
                setState({ status: 'error', transcripts: [], error: error?.message || 'Could not load transcripts.' })
            }
        })()

        return () => controller.abort()
    }, [genome, geneId])

    const handleCopy = useCallback(async (value, label) => {
        const payload = String(value || '').trim()
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

    const rows = useMemo(() => state.transcripts.map((transcript) => ({
        transcript,
        badges: transcriptBadges(transcript),
        metadata: computeTranscriptMetadata(transcript),
    })), [state.transcripts])

    // --- Styling -------------------------------------------------------------

    const textClass = isLight ? 'text-gray-800' : 'text-gray-200'
    const subTextClass = isLight ? 'text-gray-500' : 'text-gray-400'
    const dividerColor = isLight ? '#e5e7eb' : '#374151'
    const accentColor = isLight ? '#0099ff' : '#4c9aff'
    const rowHoverClass = isLight ? 'hover:bg-gray-100' : 'hover:bg-[#273449]'

    if (!gene) return null

    const start = Number(gene.start)
    const end = Number(gene.end)
    const length = (Number.isFinite(start) && Number.isFinite(end) && end >= start) ? (end - start) + 1 : 0

    return (
        <div
            className="flex flex-col h-full min-h-0 overflow-hidden border-l"
            style={{ width: FOCUS_DETAIL_WIDTH, borderColor: dividerColor }}
            data-location-gene-detail={geneId}
        >
            <div className="flex-1 min-h-0 overflow-y-auto themed-scrollbar px-3 py-2.5 flex flex-col gap-2.5">
                <section className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                        <h3 className={`text-[11px] font-semibold tracking-wide uppercase ${subTextClass}`}>Gene</h3>
                        <div className="flex-1 h-px" style={{ backgroundColor: dividerColor }} />
                        {onFocusGene && (
                            <button
                                type="button"
                                data-tour-id="location-gene-detail-focus"
                                onClick={() => onFocusGene(gene)}
                                className={`flex-none px-1.5 py-0.5 rounded text-[10px] transition-colors ${rowHoverClass}`}
                                style={{ color: accentColor }}
                                title="Focus this gene in the browser"
                            >
                                Focus gene
                            </button>
                        )}
                        <button
                            type="button"
                            data-tour-id="location-gene-detail-close"
                            onClick={() => onClose?.()}
                            className={`flex-none p-1 rounded transition-colors ${rowHoverClass}`}
                            style={{ color: accentColor }}
                            title="Close gene details"
                        >
                            <CloseGlyph />
                        </button>
                    </div>
                    <Field labelClass={subTextClass} valueClass={textClass} label="Symbol">
                        <span className="font-semibold">{gene.name || gene.id}</span>
                    </Field>
                    <Field labelClass={subTextClass} valueClass={textClass} label="Gene ID">
                        <span className="font-mono">{geneId}</span>
                        <button
                            type="button"
                            onClick={() => handleCopy(geneId, 'gene')}
                            title="Copy gene ID"
                            className="ml-1.5 align-middle opacity-80 hover:opacity-100 transition-opacity"
                            style={{ color: accentColor }}
                        >
                            <CopyGlyph />
                        </button>
                        {copied === 'gene' && <span className={`ml-1.5 text-[10px] ${subTextClass}`}>Copied</span>}
                    </Field>
                    <Field labelClass={subTextClass} valueClass={textClass} label="Biotype">{gene.biotype || '—'}</Field>
                    <Field labelClass={subTextClass} valueClass={textClass} label="Location">
                        <span className="font-mono">
                            {gene.chrom}:{formatNumber(gene.start)}-{formatNumber(gene.end)}
                        </span>
                    </Field>
                    {length > 0 && <Field labelClass={subTextClass} valueClass={textClass} label="Length">{formatNumber(length)} bp</Field>}
                    <Field labelClass={subTextClass} valueClass={textClass} label="Strand">
                        {String(gene.strand || '+') === '-' ? 'reverse strand' : 'forward strand'}
                    </Field>
                    {gene.description && <Field labelClass={subTextClass} valueClass={textClass} label="Description">{gene.description}</Field>}
                </section>

                <section className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                        <h3 className={`text-[11px] font-semibold tracking-wide uppercase ${subTextClass}`}>
                            Transcripts
                        </h3>
                        {state.status === 'done' && (
                            <span className={`flex-none text-[10px] ${subTextClass}`}>{rows.length}</span>
                        )}
                        <div className="flex-1 h-px" style={{ backgroundColor: dividerColor }} />
                    </div>

                    {state.status === 'loading' && (
                        <div className={`text-[11px] ${subTextClass}`}>Loading transcripts…</div>
                    )}
                    {state.status === 'error' && (
                        <div className="text-[11px] text-red-400">{state.error}</div>
                    )}
                    {state.status === 'done' && rows.length === 0 && (
                        <div className={`text-[11px] ${subTextClass}`}>No transcripts for this gene.</div>
                    )}

                    {rows.map(({ transcript, badges, metadata }) => (
                        <div
                            key={transcript.id}
                            className="flex flex-col gap-0.5 py-1 border-b last:border-b-0"
                            style={{ borderColor: dividerColor }}
                        >
                            <div className="flex items-center gap-1.5">
                                <span className={`font-mono text-[11px] truncate ${textClass}`}>{transcript.id}</span>
                                <button
                                    type="button"
                                    onClick={() => handleCopy(transcript.id, transcript.id)}
                                    title="Copy transcript ID"
                                    className="flex-none opacity-80 hover:opacity-100 transition-opacity"
                                    style={{ color: accentColor }}
                                >
                                    <CopyGlyph size={12} />
                                </button>
                                {copied === transcript.id && (
                                    <span className={`flex-none text-[10px] ${subTextClass}`}>Copied</span>
                                )}
                                {badges.maneSelect ? (
                                    <span className={`flex-none text-[9px] leading-[1.1] px-1.5 py-0.5 rounded-full ${isLight ? 'bg-emerald-100 text-emerald-700' : 'bg-emerald-900/30 text-emerald-400'}`}>
                                        MANE select
                                    </span>
                                ) : badges.canonical ? (
                                    <span className={`flex-none text-[9px] leading-[1.1] px-1.5 py-0.5 rounded-full ${isLight ? 'bg-green-100 text-green-700' : 'bg-green-900/30 text-green-400'}`}>
                                        canonical
                                    </span>
                                ) : null}
                                <span className={`ml-auto flex-none text-[10px] truncate max-w-[130px] ${subTextClass}`}>
                                    {transcript.biotype || ''}
                                </span>
                            </div>
                            <div className={`text-[10px] ${subTextClass}`}>
                                {formatNumber(metadata.transcriptLength)} bp ·{' '}
                                {formatNumber(metadata.exonCount)} exons
                                {metadata.hasCds
                                    ? ` · CDS ${formatNumber(metadata.cdsLength)} bp · ${formatNumber(metadata.translationLength)} aa`
                                    : ' · non-coding'}
                            </div>
                        </div>
                    ))}
                </section>
            </div>
        </div>
    )
}

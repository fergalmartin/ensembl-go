import { useMemo } from 'react'
import { describeGeneIndexStatus } from '../utils/geneIndexOverlay'

const RING_SIZE = 52
const RING_STROKE = 4
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

/**
 * The meter. A determinate ring when the backend can say how far through the
 * annotation it is, and a rotating arc when it cannot — never a bare 0%, which
 * reads as stalled.
 */
const ProgressRing = ({ percent, tone, isLight }) => {
    const accent = tone === 'error'
        ? (isLight ? '#b45309' : '#fbbf24')
        : (isLight ? '#0284c7' : '#38bdf8')
    const trackColor = isLight ? 'rgba(15, 23, 42, 0.10)' : 'rgba(226, 232, 240, 0.14)'
    const isDeterminate = Number.isFinite(percent)

    if (tone === 'error') {
        return (
            <svg width={RING_SIZE} height={RING_SIZE} viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`} aria-hidden="true">
                <circle cx={RING_SIZE / 2} cy={RING_SIZE / 2} r={RING_RADIUS} fill="none" stroke={trackColor} strokeWidth={RING_STROKE} />
                <path
                    d={`M ${RING_SIZE / 2} 17 v 13 M ${RING_SIZE / 2} 35.5 v 0.5`}
                    stroke={accent}
                    strokeWidth={3}
                    strokeLinecap="round"
                    fill="none"
                />
            </svg>
        )
    }

    return (
        <svg
            width={RING_SIZE}
            height={RING_SIZE}
            viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
            role="img"
            aria-label={isDeterminate ? `Gene index ${Math.round(percent)} percent built` : 'Gene index building'}
        >
            <circle
                cx={RING_SIZE / 2}
                cy={RING_SIZE / 2}
                r={RING_RADIUS}
                fill="none"
                stroke={trackColor}
                strokeWidth={RING_STROKE}
            />
            <g
                // Rotated so the arc starts at twelve o'clock. The indeterminate
                // arc spins this group, which keeps the transform on one element
                // and off the stroke geometry.
                style={isDeterminate ? undefined : { transformOrigin: 'center', animation: 'geneIndexSpin 1.1s linear infinite' }}
                transform={isDeterminate ? `rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})` : undefined}
            >
                <circle
                    cx={RING_SIZE / 2}
                    cy={RING_SIZE / 2}
                    r={RING_RADIUS}
                    fill="none"
                    stroke={accent}
                    strokeWidth={RING_STROKE}
                    strokeLinecap="round"
                    strokeDasharray={RING_CIRCUMFERENCE}
                    strokeDashoffset={isDeterminate
                        ? RING_CIRCUMFERENCE * (1 - Math.max(0, Math.min(1, percent / 100)))
                        : RING_CIRCUMFERENCE * 0.75}
                    // Eased rather than stepped: progress arrives every few
                    // hundred milliseconds and a jump per update looks broken.
                    style={isDeterminate ? { transition: 'stroke-dashoffset 420ms ease-out' } : undefined}
                />
            </g>
            {isDeterminate && (
                <text
                    x="50%"
                    y="50%"
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize="12"
                    fontWeight="600"
                    // Tabular figures so the digits do not shuffle the label
                    // sideways as the number climbs.
                    style={{ fontVariantNumeric: 'tabular-nums' }}
                    fill={isLight ? '#0f172a' : '#e2e8f0'}
                >
                    {Math.round(percent)}%
                </text>
            )}
        </svg>
    )
}

/**
 * The note shown over the gene tracks while their index is built.
 *
 * Positioned against the panel, not against the genome: it is centred in the
 * gene band and stays exactly there while the user pans and zooms. Everything
 * it covers is still live — `pointer-events` are off on the backdrop, so drags
 * and clicks reach the canvas underneath and the browser remains usable.
 */
const GeneIndexProgressOverlay = ({ status, isLight, top, height, left, width, onRetry }) => {
    const description = useMemo(() => describeGeneIndexStatus(status), [status])
    if (!(height > 0)) return null

    const isError = description.tone === 'error'
    const border = isError
        ? (isLight ? '#fcd34d' : 'rgba(251, 191, 36, 0.35)')
        : (isLight ? '#e2e8f0' : 'rgba(148, 163, 184, 0.25)')

    return (
        <div
            className="absolute flex items-center justify-center pointer-events-none"
            style={{ left, top, width, height, zIndex: 12 }}
            data-tour-id="browser-gene-index-progress"
        >
            <style>{'@keyframes geneIndexSpin { to { transform: rotate(360deg); } }'}</style>
            <div
                className="flex items-center gap-4 rounded-xl border px-4 py-3 shadow-sm pointer-events-auto"
                style={{
                    backgroundColor: isLight ? 'rgba(255, 255, 255, 0.94)' : 'rgba(15, 23, 42, 0.92)',
                    borderColor: border,
                    // Fixed so the card keeps one shape as the message under it
                    // changes length — "Scanning for genes" to "1,204,338 genes
                    // so far" would otherwise resize it on every update.
                    width: 340,
                    maxWidth: '92%',
                }}
                role="status"
                aria-live="polite"
            >
                <div className="flex-none">
                    <ProgressRing percent={description.percent} tone={description.tone} isLight={isLight} />
                </div>
                <div className="min-w-0">
                    <div className={`text-sm font-semibold ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>
                        {description.title}
                    </div>
                    <div className={`text-xs mt-0.5 ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                        {description.message}
                    </div>
                    {description.showRetry && onRetry && (
                        <button
                            type="button"
                            onClick={onRetry}
                            className={`mt-2 rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors ${isLight
                                ? 'border-amber-300 bg-white text-amber-800 hover:bg-amber-50'
                                : 'border-amber-400/40 bg-amber-400/10 text-amber-200 hover:bg-amber-400/20'}`}
                        >
                            Try building it again
                        </button>
                    )}
                </div>
            </div>
        </div>
    )
}

export default GeneIndexProgressOverlay

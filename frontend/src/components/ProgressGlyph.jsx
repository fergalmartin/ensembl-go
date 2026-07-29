import React from 'react'

/**
 * Shared fill-and-perimeter progress treatment used by compact action icons.
 * renderGlyph receives the same size/style/opacity props for each clipped layer.
 */
export default function ProgressGlyph({ size = 16, progress = null, renderGlyph }) {
    if (progress == null) return renderGlyph({ size })
    const pct = Math.max(0.12, Math.min(1, Number(progress || 0)))
    const frameSize = size + 8
    const inset = 1.5
    const side = frameSize - inset * 2
    const perimeter = side * 4
    const dashOffset = perimeter * (1 - pct)
    return (
        <span className="relative inline-block align-middle" style={{ width: frameSize, height: frameSize }} aria-hidden="true">
            <span
                className="absolute left-0 right-0 bottom-0 rounded-[4px] bg-current"
                style={{ height: `${pct * 100}%`, opacity: 0.16 }}
            />
            {renderGlyph({ size, opacity: 0.26, style: { position: 'absolute', left: 4, top: 4 } })}
            <span className="absolute overflow-hidden" style={{ left: 4, top: 4, width: size, height: size }}>
                <span className="absolute left-0 right-0 bottom-0 overflow-hidden" style={{ height: `${pct * 100}%` }}>
                    {renderGlyph({ size, style: { position: 'absolute', left: 0, bottom: 0 } })}
                </span>
            </span>
            <svg className="absolute inset-0" width={frameSize} height={frameSize} viewBox={`0 0 ${frameSize} ${frameSize}`} fill="none">
                <rect x={inset} y={inset} width={side} height={side} rx="4" stroke="currentColor" strokeWidth="1.6" opacity="0.24" />
                <rect
                    x={inset}
                    y={inset}
                    width={side}
                    height={side}
                    rx="4"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeDasharray={perimeter}
                    strokeDashoffset={dashOffset}
                    style={{ transition: 'stroke-dashoffset 0.25s ease' }}
                />
            </svg>
        </span>
    )
}

// Part-to-whole in one row: a horizontal stacked bar plus the list that names
// its parts.
//
// Part-to-whole rides on a stacked bar rather than a pie because the values it
// shows here are close together — A against T, C against G — and neighbouring
// slices of a circle are the one comparison people cannot make by eye. Along a
// shared baseline they are directly comparable, the exact figures sit in the
// list beside it, and eleven chromosomes fit where a pie would need eleven
// labelled wedges.
//
// Marks follow the house chart specs: 2px of surface between touching segments
// doing the separating (never a stroke), rounded outer ends, and the list
// carrying the values so no number is written across a segment.

import { useState } from 'react'

import { OTHER_SEGMENT_COLOR, sequentialRamp, shareSegments } from '../utils/shareSegments'

export { OTHER_SEGMENT_COLOR, sequentialRamp, shareSegments }

const SEGMENT_GAP_PX = 2
const MIN_SEGMENT_PX = 3

export default function ShareBar({
    segments,
    isLight,
    height = 14,
    hoveredKey = '',
    onHover = null,
    ariaLabel = '',
}) {
    const [internalHover, setInternalHover] = useState('')
    const active = hoveredKey || internalHover
    const surface = isLight ? '#ffffff' : '#1f2937'
    const drawn = segments.filter((segment) => Number(segment.value) > 0)
    if (!drawn.length) return null

    const setHover = (key) => {
        setInternalHover(key)
        onHover?.(key)
    }

    return (
        <div
            className="flex w-full items-stretch"
            style={{ height }}
            role="img"
            aria-label={ariaLabel}
            onMouseLeave={() => setHover('')}
        >
            {drawn.map((segment, index) => {
                const first = index === 0
                const last = index === drawn.length - 1
                const isActive = active === segment.key
                return (
                    <div
                        key={segment.key}
                        title={`${segment.label} — ${segment.primary || ''} ${segment.secondary || ''}`.trim()}
                        onMouseEnter={() => setHover(segment.key)}
                        style={{
                            flexGrow: Number(segment.value),
                            flexBasis: 0,
                            minWidth: MIN_SEGMENT_PX,
                            backgroundColor: segment.color,
                            // Surface, not a stroke, does the separating.
                            marginRight: last ? 0 : SEGMENT_GAP_PX,
                            borderTopLeftRadius: first ? 4 : 0,
                            borderBottomLeftRadius: first ? 4 : 0,
                            borderTopRightRadius: last ? 4 : 0,
                            borderBottomRightRadius: last ? 4 : 0,
                            // The ring is surface-coloured, so a hovered segment
                            // lifts without gaining data-weight ink.
                            boxShadow: isActive ? `0 0 0 2px ${surface}, 0 0 0 3px ${segment.color}` : 'none',
                            opacity: active && !isActive ? 0.55 : 1,
                            transition: 'opacity 120ms ease',
                        }}
                    />
                )
            })}
        </div>
    )
}

/**
 * The values behind a ShareBar: a swatch, a name, then the two figures.
 *
 * Which figure leads is the caller's call — a share reads better first for
 * bases, an absolute length first for chromosomes — so the widths the columns
 * need come with it.
 */
export function ShareList({
    segments,
    isLight,
    hoveredKey = '',
    onHover = null,
    columnsClass = 'sm:grid-cols-2',
    primaryWidthClass = 'w-24',
    secondaryWidthClass = 'w-12',
}) {
    return (
        <div className={`grid grid-cols-1 ${columnsClass} gap-x-4`}>
            {segments.map((segment) => {
                const isActive = hoveredKey === segment.key
                return (
                    <div
                        key={segment.key}
                        onMouseEnter={() => onHover?.(segment.key)}
                        onMouseLeave={() => onHover?.('')}
                        className={`flex items-center gap-2 rounded px-1 py-0.5 text-xs ${isActive
                            ? (isLight ? 'bg-gray-100' : 'bg-gray-700/50')
                            : ''
                            }`}
                    >
                        <span
                            className="h-2.5 w-2.5 shrink-0 rounded-sm"
                            style={{ backgroundColor: segment.color }}
                            aria-hidden="true"
                        />
                        <span className={`min-w-0 flex-1 truncate font-mono ${isLight ? 'text-gray-700' : 'text-gray-300'}`}>
                            {segment.label}
                        </span>
                        {/* Both figures keep their own columns so they read down
                            the list rather than drifting apart. */}
                        <span className={`${primaryWidthClass} shrink-0 text-right tabular-nums ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>
                            {segment.primary}
                        </span>
                        <span className={`${secondaryWidthClass} shrink-0 text-right tabular-nums ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                            {segment.secondary}
                        </span>
                    </div>
                )
            })}
        </div>
    )
}

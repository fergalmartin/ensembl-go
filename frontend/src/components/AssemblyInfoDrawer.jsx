// What the registry knows about the genome a panel is showing, slid out of the
// right-hand edge of that panel.
//
// Styled as the focus-gene drawer's sibling — the same surface, the same band
// pinned to the top of the panel, the same left border — but with no expand and
// collapse of its own. The genome pill in the panel's toolbar is the toggle, and
// the X in the band is the same thing said twice for the reader who has scrolled
// away from the pill.

import { useCallback } from 'react'

import { markWheelHandled } from '../utils/browsingControls'
import { buildAssemblyMetadataRows, equivalentAccessionNote } from '../utils/assemblyMetadataRows'

export const ASSEMBLY_DRAWER_WIDTH = 300

function CloseGlyph({ size = 15 }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
        </svg>
    )
}

export default function AssemblyInfoDrawer({
    theme = 'dark',
    open = false,
    onClose = null,
    genome = null,
    assemblyInfo = null,
    loading = false,
    accentColor = '',
    label = '',
    alignTop = 0,
    alignHeight = 0,
    stickyTopInset = 0,
    // Cleared out of the way of the focus-gene drawer when that panel has one,
    // so the two sit side by side rather than one over the other.
    rightInset = 0,
}) {
    const isLight = theme === 'light'

    // A wheel over the drawer belongs to the drawer's own scroller, never to the
    // browser's pan/zoom underneath it.
    const handleWheel = useCallback((event) => {
        markWheelHandled(event.nativeEvent || event)
        if (event.ctrlKey || event.metaKey) event.preventDefault()
    }, [])

    const rows = buildAssemblyMetadataRows({ genome, assemblyInfo })
    const equivalentNote = equivalentAccessionNote(
        assemblyInfo,
        String(genome?.assembly || genome?.gca || '').trim(),
    )
    const unavailableMessage = assemblyInfo?.ena?.message
        || 'No assembly metadata is available for this genome.'

    const surfaceStyle = {
        backgroundColor: isLight ? '#ffffff' : '#1E2938',
        borderColor: isLight ? '#dee2e6' : '#373a40',
    }
    const accent = accentColor || (isLight ? '#0099ff' : '#0077cc')
    const textClass = isLight ? 'text-gray-800' : 'text-gray-200'
    const subTextClass = isLight ? 'text-gray-500' : 'text-gray-400'
    const rowHoverClass = isLight ? 'hover:bg-gray-100' : 'hover:bg-[#273449]'
    const highlightColor = isLight ? '#dbe4ff' : '#2b3a55'
    const barBorderColor = isLight ? '#b1c2ff' : '#1e293b'

    // The band rides the scroll, holding at the top of the view once the
    // toolbar it lines up with has gone past — so the X stays reachable without
    // scrolling back up for it. Pulled up by the scroller's own padding so it
    // comes to rest flush under the app's top bar.
    const stickyBandStyle = { position: 'sticky', top: -Math.max(0, stickyTopInset), zIndex: 2 }
    const bandStyle = {
        backgroundColor: highlightColor,
        color: isLight ? '#1e293b' : '#ffffff',
        borderLeft: `1px solid ${barBorderColor}`,
        boxSizing: 'border-box',
    }

    return (
        <div
            data-no-drag-scroll="true"
            data-assembly-drawer="true"
            onWheel={handleWheel}
            // Overlaid rather than laid out in the row, and clamped to its own
            // panel's box, so it can never reach over the genome above or below.
            className={`absolute z-20 flex flex-col transition-[width] duration-200 ${open ? 'border-l' : ''}`}
            style={{
                ...surfaceStyle,
                width: open ? ASSEMBLY_DRAWER_WIDTH : 0,
                right: rightInset,
                top: Math.max(0, Math.round(alignTop)),
                bottom: 0,
            }}
            aria-hidden={!open}
        >
            {!open ? null : (
                <>
                    <div className="flex-none" data-assembly-drawer-band="true" style={stickyBandStyle}>
                        {/* Sized and tinted to line up with the toolbar the genome
                            pill sits in, so the drawer reads as coming out of it. */}
                        <div
                            className="px-1.5 flex items-center gap-1.5 overflow-hidden"
                            style={{ ...bandStyle, height: alignHeight || undefined }}
                        >
                            <button
                                type="button"
                                onClick={() => onClose?.()}
                                className={`flex-none flex items-center justify-center rounded transition-colors ${rowHoverClass}`}
                                style={{ width: 26, height: 22, color: accent }}
                                title="Hide assembly information"
                            >
                                <CloseGlyph size={17} />
                            </button>
                            <span className="text-xs font-semibold truncate" title={label}>{label}</span>
                        </div>
                    </div>

                    <div className="flex-1 min-h-0 overflow-y-auto themed-scrollbar" data-assembly-drawer-body="true">
                        {loading && rows.length === 0 ? (
                            <div className={`px-3 py-3 text-xs ${subTextClass}`}>Reading assembly report…</div>
                        ) : rows.length === 0 ? (
                            <div className={`px-3 py-3 text-xs ${subTextClass}`}>{unavailableMessage}</div>
                        ) : (
                            <div className="py-1.5">
                                {rows.map((row) => (
                                    // Two columns, both starting on their own left
                                    // edge: the labels line up as a column the eye
                                    // can run down, and so do the values.
                                    <div key={row.label} className="flex items-baseline gap-2 px-3 py-1 text-[11px]">
                                        <span className={`flex-none w-[86px] ${subTextClass}`}>{row.label}</span>
                                        <span className={`min-w-0 flex-1 break-words ${textClass}`} title={row.value}>
                                            {row.value}
                                        </span>
                                    </div>
                                ))}
                                {equivalentNote ? (
                                    <p className={`px-3 pt-2 pb-1 text-[10px] leading-snug ${subTextClass}`}>
                                        {equivalentNote}
                                    </p>
                                ) : null}
                            </div>
                        )}
                    </div>
                </>
            )}
        </div>
    )
}

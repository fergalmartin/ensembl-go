import { useEffect, useRef, useState } from 'react'
import { HorizontalChevron, PanelModeGlyph } from './noteGlyphs'
import { IDLE_PANEL_MODES } from './notesViewModel.js'

export function PanelModeHeader({ mode, onModeChange, expanded, onToggleExpanded, count, subtitle, isLight, accentColor, dividerColor, textPrimary, textSecondary, rowHoverClass }) {
    const [menuOpen, setMenuOpen] = useState(false)
    const menuRef = useRef(null)
    const selected = IDLE_PANEL_MODES.find((item) => item.id === mode) || IDLE_PANEL_MODES[0]

    useEffect(() => {
        if (!menuOpen) return undefined
        const close = (event) => {
            if (!menuRef.current?.contains(event.target)) setMenuOpen(false)
        }
        const closeOnEscape = (event) => {
            if (event.key === 'Escape') setMenuOpen(false)
        }
        document.addEventListener('pointerdown', close)
        document.addEventListener('keydown', closeOnEscape)
        return () => {
            document.removeEventListener('pointerdown', close)
            document.removeEventListener('keydown', closeOnEscape)
        }
    }, [menuOpen])

    return (
        <div className="relative flex min-h-[58px] w-full flex-none items-center gap-2 border-b px-3 py-2.5" style={{ borderColor: dividerColor }}>
            <button
                type="button"
                onClick={onToggleExpanded}
                className={`hidden h-[22px] w-[26px] flex-none items-center justify-center rounded transition-colors lg:flex ${rowHoverClass}`}
                style={{ color: accentColor }}
                title={expanded ? `Collapse ${selected.label.toLowerCase()}` : `Expand ${selected.label.toLowerCase()}`}
                aria-label={expanded ? `Collapse ${selected.label.toLowerCase()}` : `Expand ${selected.label.toLowerCase()}`}
                aria-expanded={expanded}
            >
                <HorizontalChevron pointsRight={expanded} size={20} />
            </button>
            <div ref={menuRef} className="relative min-w-0">
                <button
                    type="button"
                    onClick={() => setMenuOpen((current) => !current)}
                    className={`group flex min-w-0 items-center gap-2 rounded px-1 py-0.5 text-left transition-colors ${rowHoverClass}`}
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    title="Choose what this panel shows"
                >
                    <span className="min-w-0">
                        <span className={`flex items-center gap-1.5 text-sm font-semibold ${textPrimary}`}>
                            <span className="truncate">{selected.label}</span>
                            <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true" className={`flex-none transition-transform ${menuOpen ? 'rotate-180' : ''}`}>
                                <path d="m2.5 4.5 3.5 3 3.5-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                            <span className="flex flex-none items-center" style={{ color: accentColor }}><PanelModeGlyph mode={mode} size={16} /></span>
                        </span>
                        <span className={`mt-0.5 block truncate text-[11px] ${textSecondary}`}>{subtitle || selected.description}</span>
                    </span>
                </button>
                {menuOpen && (
                    <div role="menu" className={`absolute left-0 top-full z-50 mt-2 w-[250px] overflow-hidden rounded-lg border p-1.5 shadow-2xl ${isLight ? 'border-slate-200 bg-white' : 'border-slate-600 bg-slate-800'}`}>
                        {IDLE_PANEL_MODES.map((item) => {
                            const active = item.id === mode
                            return (
                                <button
                                    key={item.id}
                                    type="button"
                                    role="menuitemradio"
                                    aria-checked={active}
                                    onClick={() => {
                                        onModeChange(item.id)
                                        setMenuOpen(false)
                                    }}
                                    className={`flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left transition-colors ${active
                                        ? (isLight ? 'bg-blue-50 text-slate-900' : 'bg-blue-950/50 text-slate-100')
                                        : (isLight ? 'text-slate-700 hover:bg-slate-100' : 'text-slate-200 hover:bg-slate-700')}`}
                                >
                                    <span className="min-w-0 flex-1">
                                        <span className="block text-xs font-semibold">{item.label}</span>
                                        <span className={`mt-0.5 block text-[10px] leading-snug ${textSecondary}`}>{item.description}</span>
                                    </span>
                                    <span className="ml-auto flex h-7 w-7 flex-none items-center justify-center rounded-md" style={{ color: accentColor }}><PanelModeGlyph mode={item.id} size={17} /></span>
                                </button>
                            )
                        })}
                    </div>
                )}
            </div>
            <span className={`ml-auto flex-none text-xs ${textSecondary}`}>{count}</span>
        </div>
    )
}

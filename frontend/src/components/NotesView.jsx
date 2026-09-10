import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import AppButtonIcon from './AppButtonIcon'
import GenomePill, { genomePillLabels } from './GenomePill'
import NoteGlyph from './NoteGlyph'
import NotesTransferModal from './NotesTransferModal'
import useNoteStore from '../hooks/useNoteStore'
import useSaveOnLeaveNote from '../hooks/useSaveOnLeaveNote'
import { genomeColorResolver } from '../genomeColorSchemes'
import { API_BASE } from '../backendRuntime'
import { getAssemblyGenomeKey, getGenomeKey, genomeKeyDisplayLabels, genomeKeysMatch, normalizeGenomeRecord } from '../utils/genomeIdentity'
import {
    GENERAL_NOTES_TARGET_ID,
    NOTE_TARGET_KIND_GENE,
    NOTE_TARGET_KIND_GENOME,
    NOTE_TARGET_KIND_TODO,
    NOTE_SAVE_STATES,
    TODO_GENOME_KEY,
    TODO_TARGET_ID,
    noteDisplayTitle,
    noteTimestampLabel,
    normalizeNoteGenomeKey,
    saveIndicatorLabel,
    sortNotes,
} from '../utils/geneNotes'
import {
    DEFAULT_GENE_SORT_MODE,
    buildNoteSections,
    summariseNotes,
} from '../utils/notesViewModel'
import {
    MAX_NOTE_TAGS,
    buildTagCatalogue,
    matchTaggedNotes,
    normalizeNoteTags,
    normalizeTagText,
    sortTagCatalogue,
    suggestTags,
    tagKey,
} from '../utils/noteTags'
import {
    TODO_PRIORITIES,
    TODO_SORT_MODES,
    TODO_STATUSES,
    reorderTodos,
    sortTodos,
} from '../utils/todoNotes'
import {
    buildRecentNoteActivity,
    buildLastEditedActivity,
    buildLastViewedActivity,
    normalizeRecentNoteViews,
    recentNotePreview,
    touchRecentNoteView,
} from '../utils/recentNoteActivity'
import { beginWheelGesture, normalizeWheelDelta } from '../utils/browsingControls'

function Chevron({ open, size = 14 }) {
    return (
        <svg
            width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
            className={`transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
        >
            <polyline points="9 18 15 12 9 6" />
        </svg>
    )
}

function HorizontalChevron({ pointsRight, size = 16 }) {
    return (
        <svg
            width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
        >
            <polyline points={pointsRight ? '9 6 15 12 9 18' : '15 6 9 12 15 18'} />
        </svg>
    )
}

function TagGlyph({ size = 18 }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20.5 13.5 13.4 20.6a2 2 0 0 1-2.8 0L3.4 13.4a2 2 0 0 1-.6-1.4V5a2 2 0 0 1 2-2h7a2 2 0 0 1 1.4.6l7.3 7.1a2 2 0 0 1 0 2.8Z" />
            <circle cx="8" cy="8" r="1.35" fill="currentColor" stroke="none" />
        </svg>
    )
}

function TagChip({ label, isLight, onRemove = null, compact = false, muted = false }) {
    return (
        <span
            className={`inline-flex max-w-full items-center rounded-full border font-medium leading-none ${compact ? 'h-[18px] px-1.5 text-[9px]' : 'h-6 px-2 text-[11px]'} ${muted ? 'opacity-60' : ''} ${isLight ? 'border-slate-300 bg-slate-100 text-slate-700' : 'border-slate-600 bg-slate-800 text-slate-200'}`}
            title={label}
        >
            <span className="truncate">{label}</span>
            {onRemove && (
                <button
                    type="button"
                    onClick={() => onRemove(label)}
                    className="ml-1 flex-none opacity-50 hover:opacity-100"
                    title={`Remove ${label}`}
                    aria-label={`Remove ${label}`}
                >
                    ×
                </button>
            )}
        </span>
    )
}

function PreviewTagChips({ tags, isLight, archived = false }) {
    const normalized = normalizeNoteTags(tags)
    if (normalized.length === 0) {
        return (
            <span className={`mt-1 flex h-[18px] items-center text-[9px] italic ${isLight ? 'text-slate-400' : 'text-slate-500'}`}>
                No tags added
            </span>
        )
    }
    const visible = normalized.slice(0, 3)
    return (
        <span className="mt-1 flex h-[18px] min-w-0 items-center gap-1 overflow-hidden" aria-label={`Tags: ${normalized.join(', ')}`}>
            {visible.map((tag) => <TagChip key={tagKey(tag)} label={tag} isLight={isLight} compact muted={archived} />)}
            {normalized.length > visible.length && (
                <span className={`flex-none text-[9px] ${isLight ? 'text-slate-500' : 'text-slate-400'}`}>+{normalized.length - visible.length}</span>
            )}
        </span>
    )
}

const IDLE_PANEL_MODES = [
    { id: 'recent', label: 'Recent activity', description: 'Last ten viewed or edited items' },
    { id: 'viewed', label: 'Last viewed', description: 'Most recently opened note or task' },
    { id: 'edited', label: 'Last edited', description: 'Most recently changed note or task' },
    { id: 'tags', label: 'Tags', description: 'Browse and filter reusable tags' },
]

function PanelModeGlyph({ mode, size = 16 }) {
    if (mode === 'tags') return <TagGlyph size={size} />
    if (mode === 'edited') {
        return (
            <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" />
            </svg>
        )
    }
    if (mode === 'recent') {
        return (
            <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" />
            </svg>
        )
    }
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" /><circle cx="12" cy="12" r="2.6" />
        </svg>
    )
}

function PanelModeHeader({ mode, onModeChange, expanded, onToggleExpanded, count, subtitle, isLight, accentColor, dividerColor, textPrimary, textSecondary, rowHoverClass }) {
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

function TagEditor({ tags, onChange, catalogue, isLight, accentColor }) {
    const [input, setInput] = useState('')
    const [open, setOpen] = useState(false)
    const [sortMode, setSortMode] = useState('popular')
    const [activeIndex, setActiveIndex] = useState(-1)
    const [error, setError] = useState('')
    const rootRef = useRef(null)
    const normalized = normalizeNoteTags(tags)
    const suggestions = suggestTags(catalogue, {
        query: input,
        sortMode,
        selectedTags: normalized,
        limit: 12,
    })
    const popular = suggestTags(catalogue, {
        sortMode: 'popular',
        selectedTags: normalized,
        limit: 10,
    })

    useEffect(() => {
        if (!open) return undefined
        const close = (event) => {
            if (!rootRef.current?.contains(event.target)) {
                setOpen(false)
                setActiveIndex(-1)
            }
        }
        document.addEventListener('pointerdown', close)
        return () => document.removeEventListener('pointerdown', close)
    }, [open])

    const addTag = (raw) => {
        const token = normalizeTagText(raw)
        if (!token) {
            if (String(raw || '').trim()) setError('Use a short phrase without commas or control characters.')
            return false
        }
        const existing = catalogue.find((entry) => entry.key === tagKey(token))
        const canonical = existing?.label || token
        if (normalized.some((tag) => tagKey(tag) === tagKey(canonical))) {
            setInput('')
            setError('')
            return true
        }
        if (normalized.length >= MAX_NOTE_TAGS) {
            setError(`A note can have at most ${MAX_NOTE_TAGS} tags.`)
            return false
        }
        onChange([...normalized, canonical])
        setInput('')
        setError('')
        setActiveIndex(-1)
        return true
    }

    const addDelimited = (value) => {
        const values = String(value || '').split(',').map((part) => part.trim()).filter(Boolean)
        if (values.length === 0) return
        let next = normalized
        for (const raw of values) {
            const token = normalizeTagText(raw)
            if (!token) continue
            const existing = catalogue.find((entry) => entry.key === tagKey(token))
            const canonical = existing?.label || token
            if (next.some((tag) => tagKey(tag) === tagKey(canonical))) continue
            if (next.length >= MAX_NOTE_TAGS) {
                setError(`A note can have at most ${MAX_NOTE_TAGS} tags.`)
                break
            }
            next = [...next, canonical]
        }
        if (next !== normalized) onChange(next)
        setInput('')
    }

    const removeTag = (label) => onChange(normalized.filter((tag) => tagKey(tag) !== tagKey(label)))
    const chooseSuggestion = (tag) => {
        addTag(tag.label)
        setOpen(false)
    }

    const handleKeyDown = (event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            setOpen(true)
            const direction = event.key === 'ArrowDown' ? 1 : -1
            setActiveIndex((current) => {
                const start = current < 0 ? (direction > 0 ? -1 : 0) : current
                return (start + direction + suggestions.length) % Math.max(1, suggestions.length)
            })
            return
        }
        if (event.key === 'Escape') {
            setOpen(false)
            setActiveIndex(-1)
            return
        }
        if ((event.key === 'Enter' || event.key === ',') && (input.trim() || activeIndex >= 0)) {
            event.preventDefault()
            if (activeIndex >= 0 && suggestions[activeIndex]) chooseSuggestion(suggestions[activeIndex])
            else addTag(input)
            return
        }
        if (event.key === 'Backspace' && !input && normalized.length > 0) {
            removeTag(normalized[normalized.length - 1])
        }
    }

    return (
        <div ref={rootRef} className={`flex-none border-b px-3 py-2.5 ${isLight ? 'border-slate-200 bg-slate-50/70' : 'border-slate-700 bg-slate-900/25'}`}>
            <div className="mb-1.5 flex items-center gap-2">
                <span className={`text-[10px] font-semibold uppercase tracking-wide ${isLight ? 'text-slate-500' : 'text-slate-400'}`}>Tags</span>
                <span className={`text-[10px] ${isLight ? 'text-slate-400' : 'text-slate-500'}`}>{normalized.length}/{MAX_NOTE_TAGS}</span>
            </div>
            <div className={`relative flex min-h-9 flex-wrap items-center gap-1 rounded-md border px-2 py-1.5 focus-within:ring-2 ${isLight ? 'border-slate-300 bg-white focus-within:ring-blue-500/30' : 'border-slate-600 bg-slate-800 focus-within:ring-blue-500/30'}`}>
                {normalized.map((tag) => <TagChip key={tagKey(tag)} label={tag} isLight={isLight} onRemove={removeTag} />)}
                <input
                    value={input}
                    onChange={(event) => {
                        setInput(event.target.value)
                        setOpen(true)
                        setActiveIndex(-1)
                        setError('')
                    }}
                    onFocus={() => setOpen(true)}
                    onKeyDown={handleKeyDown}
                    onPaste={(event) => {
                        const pasted = event.clipboardData.getData('text')
                        if (!pasted.includes(',')) return
                        event.preventDefault()
                        addDelimited(pasted)
                    }}
                    disabled={normalized.length >= MAX_NOTE_TAGS}
                    placeholder={normalized.length === 0 ? 'Add a tag…' : 'Add another…'}
                    aria-label="Add a tag"
                    aria-autocomplete="list"
                    aria-expanded={open}
                    className={`h-6 min-w-[120px] flex-1 bg-transparent text-xs outline-none disabled:opacity-40 ${isLight ? 'text-slate-900 placeholder-slate-400' : 'text-slate-100 placeholder-slate-500'}`}
                />
                {open && (
                    <div className={`absolute left-0 right-0 top-full z-40 mt-1 overflow-hidden rounded-md border shadow-xl ${isLight ? 'border-slate-200 bg-white' : 'border-slate-600 bg-slate-800'}`}>
                        <div className={`flex items-center gap-1 border-b px-2 py-1.5 ${isLight ? 'border-slate-200' : 'border-slate-700'}`}>
                            {[
                                ['popular', 'Popular'],
                                ['recent', 'Recent'],
                                ['alphabetical', 'A–Z'],
                            ].map(([id, label]) => (
                                <button
                                    key={id}
                                    type="button"
                                    onClick={() => { setSortMode(id); setActiveIndex(-1) }}
                                    className={`h-6 rounded px-2 text-[10px] font-semibold ${sortMode === id ? 'text-white' : (isLight ? 'text-slate-500 hover:bg-slate-100' : 'text-slate-300 hover:bg-slate-700')}`}
                                    style={sortMode === id ? { backgroundColor: accentColor } : undefined}
                                >
                                    {label}
                                </button>
                            ))}
                        </div>
                        <div role="listbox" className="max-h-48 overflow-y-auto themed-scrollbar p-1">
                            {suggestions.map((tag, index) => (
                                <button
                                    key={tag.key}
                                    type="button"
                                    role="option"
                                    aria-selected={index === activeIndex}
                                    onMouseDown={(event) => event.preventDefault()}
                                    onClick={() => chooseSuggestion(tag)}
                                    className={`flex h-8 w-full items-center gap-2 rounded px-2 text-left text-xs ${index === activeIndex ? (isLight ? 'bg-blue-50' : 'bg-blue-950/60') : (isLight ? 'hover:bg-slate-100' : 'hover:bg-slate-700')}`}
                                >
                                    <TagGlyph size={13} />
                                    <span className="min-w-0 flex-1 truncate">{tag.label}</span>
                                    <span className={`flex-none text-[10px] ${isLight ? 'text-slate-400' : 'text-slate-500'}`}>{tag.totalCount}</span>
                                </button>
                            ))}
                            {suggestions.length === 0 && input.trim() && normalizeTagText(input) && (
                                <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => addTag(input)} className={`h-8 w-full rounded px-2 text-left text-xs ${isLight ? 'hover:bg-slate-100' : 'hover:bg-slate-700'}`}>
                                    Create “{input.trim()}”
                                </button>
                            )}
                            {suggestions.length === 0 && !input.trim() && (
                                <div className={`px-2 py-3 text-center text-xs ${isLight ? 'text-slate-400' : 'text-slate-500'}`}>No more tags to suggest</div>
                            )}
                        </div>
                    </div>
                )}
            </div>
            {error && <div className="mt-1 text-[10px] text-red-500">{error}</div>}
            {popular.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-1">
                    <span className={`mr-1 text-[10px] ${isLight ? 'text-slate-400' : 'text-slate-500'}`}>Popular</span>
                    {popular.map((tag) => (
                        <button key={tag.key} type="button" onClick={() => addTag(tag.label)} className="max-w-[150px]">
                            <TagChip label={tag.label} isLight={isLight} compact />
                        </button>
                    ))}
                </div>
            )}
        </div>
    )
}

function PlusGlyph({ size = 18 }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
        </svg>
    )
}

function DownloadGlyph({ size = 12 }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 3v12M7.5 10.5 12 15l4.5-4.5M5 20h14" />
        </svg>
    )
}

// One arrow, pointed out of the tray for an export and into it for an import.
function TransferGlyph({ size = 14, direction = 'out' }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
            {direction === 'out'
                ? <path d="M12 15V3M12 3 8 7M12 3l4 4" />
                : <path d="M12 3v12M12 15l-4-4M12 15l4-4" />}
        </svg>
    )
}

function TrashGlyph({ size = 18 }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 7h16M10 7V5h4v2M6 7l1 13h10l1-13" />
        </svg>
    )
}

function CloseGlyph({ size = 15 }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
        </svg>
    )
}

function ArchiveGlyph({ restore = false, size = 18 }) {
    if (restore) {
        return (
            <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4.25 9A8 8 0 1 1 4 14.25" />
                <path d="M4.25 4.5V9h4.5" />
            </svg>
        )
    }
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="4" y="3.5" width="16" height="7" rx="1.25" />
            <rect x="4" y="13.5" width="16" height="7" rx="1.25" />
            <path d="M9 7h6M9 17h6" />
        </svg>
    )
}

function EditGlyph({ size = 18 }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 20h4l11-11a2.8 2.8 0 0 0-4-4L4 16v4z" />
            <path d="m13.5 6.5 4 4" />
        </svg>
    )
}

function CompleteGlyph({ restore = false, size = 17 }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {restore
                ? <><path d="M8 7H4v-4" /><path d="M4.5 7.5A8 8 0 1 1 4 15" /></>
                : <path d="m4 12 5 5L20 6" />}
        </svg>
    )
}

function DragGlyph({ size = 16 }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="9" cy="6" r="1.4" /><circle cx="15" cy="6" r="1.4" />
            <circle cx="9" cy="12" r="1.4" /><circle cx="15" cy="12" r="1.4" />
            <circle cx="9" cy="18" r="1.4" /><circle cx="15" cy="18" r="1.4" />
        </svg>
    )
}

function ColorDotSelect({ id, value, items, onChange, colorForValue, isLight, widthClass }) {
    const [open, setOpen] = useState(false)
    const rootRef = useRef(null)
    const buttonRef = useRef(null)
    const selected = items.find((item) => item.id === value) || items[0]

    useEffect(() => {
        if (!open) return undefined
        const closeOnOutsidePress = (event) => {
            if (!rootRef.current?.contains(event.target)) setOpen(false)
        }
        const closeOnOutsideFocus = (event) => {
            if (!rootRef.current?.contains(event.target)) setOpen(false)
        }
        const closeOnEscape = (event) => {
            if (event.key === 'Escape') {
                setOpen(false)
                buttonRef.current?.focus()
            }
        }
        document.addEventListener('pointerdown', closeOnOutsidePress)
        document.addEventListener('focusin', closeOnOutsideFocus)
        document.addEventListener('keydown', closeOnEscape)
        return () => {
            document.removeEventListener('pointerdown', closeOnOutsidePress)
            document.removeEventListener('focusin', closeOnOutsideFocus)
            document.removeEventListener('keydown', closeOnEscape)
        }
    }, [open])

    const choose = (nextValue) => {
        onChange(nextValue)
        setOpen(false)
        buttonRef.current?.focus()
    }

    const focusOption = (index) => {
        window.requestAnimationFrame(() => {
            const options = rootRef.current?.querySelectorAll('[role="option"]')
            options?.[Math.max(0, Math.min(index, options.length - 1))]?.focus()
        })
    }

    const handleTriggerKeyDown = (event) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
        event.preventDefault()
        setOpen(true)
        const selectedIndex = Math.max(0, items.findIndex((item) => item.id === value))
        focusOption(event.key === 'ArrowUp' ? items.length - 1 : selectedIndex)
    }

    const handleOptionKeyDown = (event, index) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
        event.preventDefault()
        const offset = event.key === 'ArrowDown' ? 1 : -1
        focusOption((index + offset + items.length) % items.length)
    }

    return (
        <div ref={rootRef} className={`relative flex-none ${widthClass}`}>
            <button
                ref={buttonRef}
                id={id}
                type="button"
                onClick={() => setOpen((current) => !current)}
                onKeyDown={handleTriggerKeyDown}
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-controls={`${id}-options`}
                className={`flex h-7 w-full items-center gap-2 rounded-md border px-2 text-left text-xs focus:outline-none focus:ring-2 ${isLight
                    ? 'bg-white border-gray-300 text-gray-900 focus:ring-blue-500/40'
                    : 'bg-gray-700 border-gray-600 text-gray-100 focus:ring-blue-500/40'}`}
            >
                <span className="h-2.5 w-2.5 flex-none rounded-full ring-1 ring-black/10" style={{ backgroundColor: colorForValue(selected.id) }} />
                <span className="min-w-0 flex-1 truncate">{selected.label}</span>
                <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true" className={`flex-none transition-transform ${open ? 'rotate-180' : ''}`}>
                    <path d="m2.5 4.5 3.5 3 3.5-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
            </button>
            {open && (
                <div
                    id={`${id}-options`}
                    role="listbox"
                    aria-labelledby={id}
                    className={`absolute left-0 top-full z-30 mt-1 min-w-full overflow-hidden rounded-md border p-1 shadow-xl ${isLight
                        ? 'bg-white border-gray-200'
                        : 'bg-gray-800 border-gray-600'}`}
                >
                    {items.map((item, index) => (
                        <button
                            key={item.id}
                            type="button"
                            role="option"
                            aria-selected={item.id === value}
                            onClick={() => choose(item.id)}
                            onKeyDown={(event) => handleOptionKeyDown(event, index)}
                            className={`flex h-7 w-full items-center gap-2 rounded px-2 text-left text-xs ${item.id === value
                                ? (isLight ? 'bg-blue-50 text-gray-900' : 'bg-blue-950/60 text-gray-100')
                                : (isLight ? 'text-gray-700 hover:bg-gray-100' : 'text-gray-200 hover:bg-gray-700')}`}
                        >
                            <span className="h-2.5 w-2.5 flex-none rounded-full ring-1 ring-black/10" style={{ backgroundColor: colorForValue(item.id) }} />
                            <span className="whitespace-nowrap">{item.label}</span>
                        </button>
                    ))}
                </div>
            )}
        </div>
    )
}

const todoLabel = (items, value) => items.find((item) => item.id === value)?.label || value
const statusDotColor = (status) => ({
    backlog: '#94a3b8',
    next: '#38bdf8',
    in_progress: '#3b82f6',
    waiting: '#14b8a6',
    blocked: '#64748b',
    completed: '#22c55e',
    abandoned: '#a1a1aa',
}[status] || '#94a3b8')
const priorityDotColor = (priority) => ({
    low: '#eab308',
    medium: '#f97316',
    high: '#ef4444',
}[priority] || '#eab308')

function notesGenomeRecord(species, { active = false, color = null, browsable = false } = {}) {
    if (!species) return null
    const selectionKey = getGenomeKey(species)
    return {
        species,
        selectionKey,
        notesGenomeKey: normalizeNoteGenomeKey(getAssemblyGenomeKey(species)),
        name: species?.display_name || species?.scientific_name || selectionKey,
        assemblyName: species?.assembly_name || species?.assembly || '',
        labels: genomePillLabels(species),
        color,
        active,
        browsable,
    }
}

function fallbackGenomePillLabels(genomeKey) {
    return genomeKeyDisplayLabels(genomeKey)
}

/** How long "Confirm" stands before a delete button goes back to asking. */
const DELETE_CONFIRM_MS = 4000
const RECENT_NOTE_VIEWS_STORAGE_KEY = 'ensembl-go-notes-recent-views-v1'

function loadRecentNoteViews() {
    if (typeof window === 'undefined') return []
    try {
        return normalizeRecentNoteViews(JSON.parse(window.localStorage.getItem(RECENT_NOTE_VIEWS_STORAGE_KEY) || '[]'))
    } catch {
        return []
    }
}

/**
 * Everything the user has written, in one place.
 *
 * The drawer in the genome browser answers "what did I say about this gene?".
 * This answers the questions the drawer cannot: which genes have I annotated,
 * what did I say about them, and where has my attention actually been. Notes are
 * grouped by genome and then by gene, because the gene is what a note is *about*
 * and the genome is what makes two notes on the same symbol different things.
 */
export default function NotesView({
    theme = 'dark',
    config = null,
    topBarSpecies = null,
    activeSpecies = null,
    onGenomeFocusGeneSelect = null,
    onNavigateToBrowser = null,
    onAddGenome = null,
    onRedownloadGenome = null,
}) {
    const isLight = theme === 'light'
    const store = useNoteStore()
    const reloadNotes = store.reload

    // The provider outlives individual views. Refresh here so a task changed
    // in another app window does not carry a stale compare-and-swap token into
    // its editor or archive action.
    useEffect(() => {
        reloadNotes()
    }, [reloadNotes])

    const [query, setQuery] = useState('')
    const [selectedTags, setSelectedTags] = useState([])
    const [tagMatchMode, setTagMatchMode] = useState('all')
    const [idlePanelMode, setIdlePanelMode] = useState('recent')
    const [tagCatalogueQuery, setTagCatalogueQuery] = useState('')
    const [tagCatalogueSort, setTagCatalogueSort] = useState('popular')
    const [expandedTagContexts, setExpandedTagContexts] = useState({})
    const [collapsedSections, setCollapsedSections] = useState({})
    const [collapsedNoteGroups, setCollapsedNoteGroups] = useState({})
    const [openNoteId, setOpenNoteId] = useState('')
    const [confirmingDeleteId, setConfirmingDeleteId] = useState('')
    const [busyGenomeKey, setBusyGenomeKey] = useState('')
    const [noteSet, setNoteSet] = useState('active')
    const [archiveBusyKey, setArchiveBusyKey] = useState('')
    const [bulkDeleteRequest, setBulkDeleteRequest] = useState(null)
    const [bulkDeleteBusy, setBulkDeleteBusy] = useState(false)
    const [openTodoId, setOpenTodoId] = useState('')
    const [todoDraft, setTodoDraft] = useState(null)
    const [detailEditing, setDetailEditing] = useState(false)
    const [todoSortMode, setTodoSortMode] = useState('manual')
    const [draggedTodoId, setDraggedTodoId] = useState('')
    const [localGenomeRecords, setLocalGenomeRecords] = useState([])
    const [localGenomeLookupReady, setLocalGenomeLookupReady] = useState(false)
    const [recentNoteViews, setRecentNoteViews] = useState(loadRecentNoteViews)
    const [idlePanelExpanded, setIdlePanelExpanded] = useState(false)
    const [idlePanelFollowing, setIdlePanelFollowing] = useState(false)
    const [transferTab, setTransferTab] = useState('')
    const [transferNotice, setTransferNotice] = useState(null)
    const [detailFixedTop, setDetailFixedTop] = useState(220)
    const confirmTimerRef = useRef(null)
    const scrollContainerRef = useRef(null)
    const todoSectionRef = useRef(null)
    const genomeSectionRefs = useRef(new Map())
    const detailWheelGestureRef = useRef(null)

    const handleIdlePanelWheel = useCallback((event) => {
        const outerScroller = scrollContainerRef.current
        if (!outerScroller) return

        const wheel = normalizeWheelDelta(event, { pageHeight: outerScroller.clientHeight })
        if (!wheel.dy || Math.abs(wheel.dy) < Math.abs(wheel.dx)) return

        const previousGesture = detailWheelGestureRef.current
        const gesture = beginWheelGesture(previousGesture, wheel, event.timeStamp)
        const panel = event.currentTarget
        const hoveredSurface = typeof event.target?.closest === 'function'
            ? event.target.closest('[data-notes-detail-scroll]')
            : null
        const hoveredPanelSurface = hoveredSurface && panel.contains(hoveredSurface)
            ? hoveredSurface
            : null

        let mode = gesture.continues ? previousGesture?.mode : (hoveredPanelSurface ? 'inner' : 'outer')
        let innerScroller = gesture.continues ? previousGesture?.innerScroller : hoveredPanelSurface
        if (mode === 'inner' && (!innerScroller?.isConnected || !panel.contains(innerScroller))) {
            innerScroller = hoveredPanelSurface
            mode = innerScroller ? 'inner' : 'outer'
        }

        if (event.cancelable) event.preventDefault()

        if (mode === 'inner' && innerScroller) {
            const maxInnerScroll = Math.max(0, innerScroller.scrollHeight - innerScroller.clientHeight)
            const currentInnerScroll = innerScroller.scrollTop
            const nextInnerScroll = Math.max(0, Math.min(maxInnerScroll, currentInnerScroll + wheel.dy))
            const consumedDelta = nextInnerScroll - currentInnerScroll
            const remainingDelta = wheel.dy - consumedDelta

            innerScroller.scrollTop = nextInnerScroll
            if (remainingDelta) outerScroller.scrollTop += remainingDelta

            const reachedDirectionalEdge = wheel.dy > 0
                ? nextInnerScroll >= maxInnerScroll - 0.5
                : nextInnerScroll <= 0.5
            if (reachedDirectionalEdge) mode = 'outer'
        } else {
            outerScroller.scrollTop += wheel.dy
        }

        detailWheelGestureRef.current = {
            ...gesture,
            mode,
            innerScroller: mode === 'inner' ? innerScroller : null,
        }
    }, [])

    const recordRecentActivity = useCallback((noteId) => {
        setRecentNoteViews((current) => touchRecentNoteView(current, noteId))
    }, [])

    useEffect(() => {
        try {
            window.localStorage.setItem(RECENT_NOTE_VIEWS_STORAGE_KEY, JSON.stringify(recentNoteViews))
        } catch {
            // Recent activity is still available for this visit if storage is blocked.
        }
    }, [recentNoteViews])

    useEffect(() => {
        const scrollContainer = scrollContainerRef.current
        const todoSection = todoSectionRef.current
        if (!scrollContainer || !todoSection) return undefined

        let stickyStart = 0
        let following = false
        const updateFollowingState = () => {
            const nextFollowing = scrollContainer.scrollTop >= stickyStart
            if (nextFollowing === following) return
            following = nextFollowing
            setIdlePanelFollowing(nextFollowing)
        }
        const measureStickyBoundary = () => {
            const scrollContainerRect = scrollContainer.getBoundingClientRect()
            stickyStart = todoSection.getBoundingClientRect().top
                - scrollContainerRect.top
                + scrollContainer.scrollTop
            setDetailFixedTop(Math.round(scrollContainerRect.top))
            updateFollowingState()
        }

        scrollContainer.addEventListener('scroll', updateFollowingState, { passive: true })
        window.addEventListener('resize', measureStickyBoundary)
        const resizeObserver = typeof ResizeObserver === 'function'
            ? new ResizeObserver(measureStickyBoundary)
            : null
        resizeObserver?.observe(scrollContainer)
        measureStickyBoundary()

        return () => {
            scrollContainer.removeEventListener('scroll', updateFollowingState)
            window.removeEventListener('resize', measureStickyBoundary)
            resizeObserver?.disconnect()
        }
    }, [])

    const bg = isLight ? 'bg-[#f8f9fa]' : 'bg-[#111827]'
    const contentBg = isLight ? 'bg-white' : 'bg-[#1a2232]'
    const borderClass = isLight ? 'border-gray-200' : 'border-gray-700'
    const textPrimary = isLight ? 'text-gray-900' : 'text-gray-100'
    const textSecondary = isLight ? 'text-gray-500' : 'text-gray-400'
    const rowHoverClass = isLight ? 'hover:bg-gray-100' : 'hover:bg-[#273449]'
    const collapseArrowClass = `inline-flex h-7 w-5 flex-none items-center justify-center border-0 bg-transparent p-0 opacity-55 transition-all hover:scale-110 hover:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-400/60 ${isLight
        ? 'text-gray-500 hover:text-blue-600'
        : 'text-gray-400 hover:text-blue-300'}`
    // Icon-only actions deliberately have no visible button chrome. Keeping one
    // square hit target makes their artwork align while hover/focus emphasises
    // the mark itself rather than drawing a differently shaped button around it.
    const iconActionClass = 'flex-none inline-flex h-7 w-7 items-center justify-center border-0 bg-transparent p-0 opacity-70 transition-all hover:scale-110 hover:opacity-100 focus-visible:scale-110 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60 disabled:scale-100 disabled:opacity-25 disabled:cursor-default'
    const transferButtonClass = `inline-flex h-8 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold transition-colors ${isLight ? 'border-gray-300 bg-gray-50 text-gray-700 hover:bg-gray-100' : 'border-gray-600 bg-gray-900 text-gray-300 hover:bg-[#273449]'}`
    const dividerColor = isLight ? '#e5e7eb' : '#374151'
    const accentColor = isLight ? '#0099ff' : '#4c9aff'
    const dangerColor = isLight ? '#dc2626' : '#f87171'
    const cardBg = isLight ? '#f8fafc' : '#161d29'
    const compactSelectCls = `h-7 rounded-md border px-2 pr-7 text-xs focus:outline-none focus:ring-2 ${isLight
        ? 'bg-white border-gray-300 text-gray-900 focus:ring-blue-500/40'
        : 'bg-gray-700 border-gray-600 text-gray-100 focus:ring-blue-500/40'}`
    const workflowTagClass = 'inline-flex h-5 min-w-[58px] flex-none items-center justify-center rounded-full border px-2 text-[10px] font-semibold leading-none'
    const statusTagClass = (status) => ({
        backlog: isLight
            ? 'bg-slate-50 text-slate-600 border-slate-300'
            : 'bg-slate-800/70 text-slate-300 border-slate-600',
        next: isLight
            ? 'bg-sky-50 text-sky-700 border-sky-300'
            : 'bg-sky-950/55 text-sky-300 border-sky-700',
        in_progress: isLight
            ? 'bg-blue-50 text-blue-700 border-blue-400'
            : 'bg-blue-950/55 text-blue-300 border-blue-600',
        waiting: isLight
            ? 'bg-teal-50 text-teal-700 border-teal-300'
            : 'bg-teal-950/55 text-teal-300 border-teal-700',
        blocked: isLight
            ? 'bg-slate-100 text-slate-700 border-slate-400'
            : 'bg-slate-800 text-slate-200 border-slate-500',
        completed: isLight
            ? 'bg-emerald-50 text-emerald-700 border-emerald-400'
            : 'bg-emerald-950/55 text-emerald-300 border-emerald-600',
        abandoned: isLight
            ? 'bg-zinc-100 text-zinc-600 border-zinc-400'
            : 'bg-zinc-800 text-zinc-300 border-zinc-500',
    }[status] || (isLight
        ? 'bg-slate-50 text-slate-600 border-slate-300'
        : 'bg-slate-800/70 text-slate-300 border-slate-600'))
    const priorityTagClass = (priority) => ({
        low: isLight
            ? 'bg-yellow-50 text-yellow-800 border-yellow-300'
            : 'bg-yellow-950/45 text-yellow-200 border-yellow-700',
        medium: isLight
            ? 'bg-orange-100 text-orange-800 border-orange-400'
            : 'bg-orange-950/55 text-orange-200 border-orange-600',
        high: isLight
            ? 'bg-red-100 text-red-800 border-red-400'
            : 'bg-red-950/55 text-red-200 border-red-600',
    }[priority] || (isLight
        ? 'bg-yellow-50 text-yellow-800 border-yellow-300'
        : 'bg-yellow-950/45 text-yellow-200 border-yellow-700'))

    useEffect(() => {
        const controller = new AbortController()
        let cancelled = false

        const loadLocalGenomes = async () => {
            setLocalGenomeLookupReady(false)
            const candidates = []
            const push = (item, manual = false) => {
                const record = normalizeGenomeRecord(manual ? { ...item, is_manual: true } : item)
                if (!record || (!record?.files?.gff3 && !record?.files?.fasta)) return
                if (candidates.some((candidate) => getGenomeKey(candidate) === getGenomeKey(record))) return
                candidates.push(record)
            }

            try {
                const outputDir = String(config?.output_dir || '').trim()
                if (outputDir) {
                    const res = await fetch(`${API_BASE}/api/remote/local-assemblies?output_dir=${encodeURIComponent(outputDir)}`, {
                        signal: controller.signal,
                    })
                    if (res.ok) {
                        const listed = await res.json()
                        for (const item of (Array.isArray(listed) ? listed : [])) {
                            push(item)
                            for (const instance of (Array.isArray(item?.dataset_instances) ? item.dataset_instances : [])) push(instance)
                        }
                    }
                }
                for (const item of (config?.manual_species || [])) push(item, true)
                if (!cancelled) setLocalGenomeRecords(candidates)
            } catch (error) {
                if (error?.name !== 'AbortError' && !cancelled) setLocalGenomeRecords([])
            } finally {
                if (!cancelled) setLocalGenomeLookupReady(true)
            }
        }

        loadLocalGenomes()
        return () => {
            cancelled = true
            controller.abort()
        }
    }, [config?.manual_species, config?.output_dir])

    // Every genome in the top bar, in the exact order its pill sits there. The
    // active subset supplies browser colours and capabilities; inactive pills
    // remain full genome records so Notes can label them just as clearly.
    const activeGenomes = useMemo(() => {
        const active = Array.isArray(activeSpecies)
            ? activeSpecies
            : (Array.isArray(config?.active_species) ? config.active_species : [])
        const species = Array.isArray(topBarSpecies) ? topBarSpecies : active
        const activeKeys = new Set(active.map((item) => getGenomeKey(item)))
        const resolveColor = genomeColorResolver(config)
        // A genome with no annotation gets no panel, so it is not browsable and
        // wears no colour here either — but the colour it would wear is its own,
        // not the position it happens to hold.
        const panelOrder = active.filter((item) => Boolean(item?.files?.gff3)).map((item) => getGenomeKey(item))
        return species.map((item) => {
            const selectionKey = getGenomeKey(item)
            const panelIndex = panelOrder.indexOf(selectionKey)
            const isActive = activeKeys.has(selectionKey)
            return notesGenomeRecord(item, {
                active: isActive,
                color: panelIndex >= 0 ? resolveColor(item) : null,
                browsable: isActive && panelIndex >= 0,
            })
        })
    }, [activeSpecies, config, topBarSpecies])

    const availableLocalGenomes = useMemo(
        () => localGenomeRecords.map((item) => notesGenomeRecord(item)),
        [localGenomeRecords],
    )

    const showingArchived = noteSet === 'archived'
    const archiveActionColor = showingArchived ? '#22c55e' : accentColor
    const selectedCountClass = isLight ? 'font-semibold text-blue-700' : 'font-semibold text-blue-300'
    const activeCountClass = showingArchived ? textSecondary : selectedCountClass
    const archivedCountClass = showingArchived ? selectedCountClass : textSecondary
    const activeGenomeNotes = useMemo(() => store.notes.filter((note) => (
        note?.target?.kind === NOTE_TARGET_KIND_GENE || note?.target?.kind === NOTE_TARGET_KIND_GENOME
    )), [store.notes])
    const archivedGenomeNotes = useMemo(() => store.archivedNotes.filter((note) => (
        note?.target?.kind === NOTE_TARGET_KIND_GENE || note?.target?.kind === NOTE_TARGET_KIND_GENOME
    )), [store.archivedNotes])
    const activeTodoNotes = useMemo(
        () => store.notes.filter((note) => note?.target?.kind === NOTE_TARGET_KIND_TODO),
        [store.notes],
    )
    const archivedTodoNotes = useMemo(
        () => store.archivedNotes.filter((note) => note?.target?.kind === NOTE_TARGET_KIND_TODO),
        [store.archivedNotes],
    )
    const todoNotes = showingArchived ? archivedTodoNotes : activeTodoNotes
    const visibleTodoNotes = useMemo(
        () => matchTaggedNotes(todoNotes, { query, selectedTags, matchMode: tagMatchMode }),
        [query, selectedTags, tagMatchMode, todoNotes],
    )
    const sortedTodoNotes = useMemo(
        () => sortTodos(visibleTodoNotes, todoSortMode),
        [visibleTodoNotes, todoSortMode],
    )
    const currentNotes = showingArchived ? archivedGenomeNotes : activeGenomeNotes
    const visibleNotes = useMemo(
        () => matchTaggedNotes(currentNotes, { query, selectedTags, matchMode: tagMatchMode }),
        [currentNotes, query, selectedTags, tagMatchMode],
    )
    const allNotes = useMemo(
        () => [...activeGenomeNotes, ...archivedGenomeNotes],
        [activeGenomeNotes, archivedGenomeNotes],
    )
    const allStoredNotes = useMemo(
        () => [...store.notes, ...store.archivedNotes],
        [store.archivedNotes, store.notes],
    )
    const recentActivity = useMemo(
        () => buildRecentNoteActivity(allStoredNotes, recentNoteViews),
        [allStoredNotes, recentNoteViews],
    )
    const lastViewedActivity = useMemo(
        () => buildLastViewedActivity(allStoredNotes, recentNoteViews),
        [allStoredNotes, recentNoteViews],
    )
    const lastEditedActivity = useMemo(() => buildLastEditedActivity(allStoredNotes), [allStoredNotes])
    const visibleActivity = idlePanelMode === 'edited'
        ? lastEditedActivity
        : (idlePanelMode === 'viewed' ? lastViewedActivity : recentActivity)
    const tagCatalogue = useMemo(() => buildTagCatalogue(allStoredNotes), [allStoredNotes])
    const visibleTagCatalogue = useMemo(() => {
        const needle = tagCatalogueQuery.trim().toLowerCase()
        const filtered = needle
            ? tagCatalogue.filter((tag) => tag.label.toLowerCase().includes(needle))
            : tagCatalogue
        return sortTagCatalogue(filtered, tagCatalogueSort)
    }, [tagCatalogue, tagCatalogueQuery, tagCatalogueSort])
    const visibleNoteIds = useMemo(() => new Set(visibleNotes.map((note) => note.id)), [visibleNotes])
    const hasFilters = Boolean(query.trim() || selectedTags.length > 0)
    const sections = useMemo(() => buildNoteSections(allNotes, activeGenomes, { geneSortMode: DEFAULT_GENE_SORT_MODE })
        .map((section) => {
            const localGenome = section.genome || availableLocalGenomes.find(
                (candidate) => genomeKeysMatch(candidate.species, section.genomeKey),
            ) || null
            return {
                ...section,
                genome: localGenome,
                genes: section.genes.filter((geneRow) => {
                    if (showingArchived && geneRow.archivedCount === 0) return false
                    if (!hasFilters) return true
                    return geneRow.notes.some((note) => visibleNoteIds.has(note.id))
                }),
            }
        })
        .filter((section) => {
            if (hasFilters) {
                const generalMatches = section.generalNotes.some((note) => visibleNoteIds.has(note.id))
                return section.genes.length > 0 || generalMatches
            }
            if (showingArchived) return section.archivedNoteCount > 0
            return true
        }), [activeGenomes, allNotes, availableLocalGenomes, hasFilters, showingArchived, visibleNoteIds])
    const totals = useMemo(
        () => summariseNotes(buildNoteSections(visibleNotes, [], { geneSortMode: DEFAULT_GENE_SORT_MODE })),
        [visibleNotes],
    )
    const openNote = store.notesById[openNoteId] || null
    const openTodo = store.notesById[openTodoId] || null
    const todoEditorNote = todoDraft || openTodo
    const detailOpen = Boolean(openNote || todoEditorNote)

    useSaveOnLeaveNote(openNoteId, store.saveNote)
    useSaveOnLeaveNote(openTodoId, store.saveNote)

    const clearConfirmTimer = useCallback(() => {
        if (confirmTimerRef.current) {
            clearTimeout(confirmTimerRef.current)
            confirmTimerRef.current = null
        }
    }, [])
    useEffect(() => clearConfirmTimer, [clearConfirmTimer])

    const handleCloseNote = useCallback(() => {
        clearConfirmTimer()
        setConfirmingDeleteId('')
        setOpenNoteId('')
        setDetailEditing(false)
    }, [clearConfirmTimer])

    const handleCloseTodo = useCallback(() => {
        clearConfirmTimer()
        setConfirmingDeleteId('')
        setTodoDraft(null)
        setOpenTodoId('')
        setDetailEditing(false)
    }, [clearConfirmTimer])

    const handleCloseDetail = useCallback(() => {
        handleCloseNote()
        handleCloseTodo()
    }, [handleCloseNote, handleCloseTodo])

    const scrollToNotesSection = useCallback((sectionKey) => {
        // Selection animates the workspace columns for 180ms. Measure only
        // after that transition, otherwise the genome rows are still moving.
        window.requestAnimationFrame(() => {
            window.setTimeout(() => {
                const section = sectionKey === TODO_GENOME_KEY
                    ? todoSectionRef.current
                    : genomeSectionRefs.current.get(sectionKey)
                const scrollContainer = scrollContainerRef.current
                if (!section || !scrollContainer) return
                const sectionTop = section.getBoundingClientRect().top
                const containerTop = scrollContainer.getBoundingClientRect().top
                scrollContainer.scrollTo({
                    top: scrollContainer.scrollTop + sectionTop - containerTop,
                    behavior: 'smooth',
                })
            }, 220)
        })
    }, [])

    // A transfer finishes by closing its dialog, so the confirmation has to live
    // out here. Same shape and lifetime as the sequence-export toast.
    useEffect(() => {
        if (!transferNotice) return undefined
        const timer = setTimeout(() => setTransferNotice(null), 6000)
        return () => clearTimeout(timer)
    }, [transferNotice])

    const handleNoteSetChange = useCallback((nextSet) => {
        if (nextSet === noteSet) return
        handleCloseNote()
        handleCloseTodo()
        setBulkDeleteRequest(null)
        setNoteSet(nextSet)
    }, [handleCloseNote, handleCloseTodo, noteSet])

    const handleDelete = useCallback((noteId) => {
        if (confirmingDeleteId !== noteId) {
            clearConfirmTimer()
            setConfirmingDeleteId(noteId)
            confirmTimerRef.current = setTimeout(() => {
                confirmTimerRef.current = null
                setConfirmingDeleteId('')
            }, DELETE_CONFIRM_MS)
            return
        }
        clearConfirmTimer()
        setConfirmingDeleteId('')
        if (openNoteId === noteId) {
            setOpenNoteId('')
            setDetailEditing(false)
        }
        if (openTodoId === noteId) {
            setOpenTodoId('')
            setDetailEditing(false)
        }
        store.deleteNote(noteId)
    }, [confirmingDeleteId, clearConfirmTimer, openNoteId, openTodoId, store])

    const handleArchiveNotes = useCallback(async (noteIds, archived, busyKey) => {
        const ids = [...new Set((Array.isArray(noteIds) ? noteIds : [])
            .map((noteId) => String(noteId || '').trim())
            .filter(Boolean))]
        if (ids.length === 0 || archiveBusyKey) return
        setArchiveBusyKey(busyKey)
        try {
            const changed = await Promise.all(ids.map((noteId) => store.setNoteArchived(noteId, archived)))
            const openNoteIndex = ids.indexOf(openNoteId)
            if (openNoteIndex >= 0 && changed[openNoteIndex]) handleCloseNote()
            const openTodoIndex = ids.indexOf(openTodoId)
            if (openTodoIndex >= 0 && changed[openTodoIndex]) handleCloseTodo()
        } finally {
            setArchiveBusyKey('')
        }
    }, [archiveBusyKey, handleCloseNote, handleCloseTodo, openNoteId, openTodoId, store])

    const requestBulkDelete = useCallback((noteIds, label) => {
        const ids = [...new Set((Array.isArray(noteIds) ? noteIds : [])
            .map((noteId) => String(noteId || '').trim())
            .filter(Boolean))]
        if (ids.length === 0) return
        setBulkDeleteRequest({ noteIds: ids, label })
    }, [])

    const confirmBulkDelete = useCallback(async () => {
        if (!bulkDeleteRequest || bulkDeleteBusy) return
        setBulkDeleteBusy(true)
        const deletingOpenNote = bulkDeleteRequest.noteIds.includes(openNoteId)
        const deletingOpenTodo = bulkDeleteRequest.noteIds.includes(openTodoId)
        try {
            const deleted = await store.deleteNotes(bulkDeleteRequest.noteIds)
            if (deleted && deletingOpenNote) handleCloseNote()
            if (deleted && deletingOpenTodo) handleCloseTodo()
            if (deleted) setBulkDeleteRequest(null)
        } finally {
            setBulkDeleteBusy(false)
        }
    }, [bulkDeleteBusy, bulkDeleteRequest, handleCloseNote, handleCloseTodo, openNoteId, openTodoId, store])

    const noteIdsForGenome = useCallback((genomeKey) => currentNotes
        .filter((note) => !note.pending && normalizeNoteGenomeKey(note?.target?.genome_key) === genomeKey)
        .map((note) => note.id), [currentNotes])

    const noteIdsForGene = useCallback((genomeKey, geneId) => currentNotes
        .filter((note) => !note.pending
            && note?.target?.kind === NOTE_TARGET_KIND_GENE
            && normalizeNoteGenomeKey(note?.target?.genome_key) === genomeKey
            && String(note?.target?.id || '') === geneId)
        .map((note) => note.id), [currentNotes])

    const noteIdsForGeneral = useCallback((genomeKey) => currentNotes
        .filter((note) => !note.pending
            && note?.target?.kind === NOTE_TARGET_KIND_GENOME
            && normalizeNoteGenomeKey(note?.target?.genome_key) === genomeKey
            && String(note?.target?.id || '') === GENERAL_NOTES_TARGET_ID)
        .map((note) => note.id), [currentNotes])

    const handleCreate = useCallback((genomeKey, geneId, label, selectionKey) => {
        setTodoDraft(null)
        setOpenTodoId('')
        setCollapsedNoteGroups((current) => ({ ...current, [`gene:${genomeKey}:${geneId}`]: false }))
        const { tempId } = store.createNote(
            {
                kind: NOTE_TARGET_KIND_GENE,
                genome_key: genomeKey,
                id: geneId,
                label: label || '',
                genome_selection_key: selectionKey || '',
            },
            {
                onIdAssigned: (fromId, toId) => {
                    setOpenNoteId((current) => (current === fromId ? toId : current))
                    if (toId) recordRecentActivity(toId)
                },
            },
        )
        setOpenNoteId(tempId)
        setDetailEditing(true)
        scrollToNotesSection(genomeKey)
    }, [recordRecentActivity, scrollToNotesSection, store])

    const handleCreateGeneral = useCallback((genomeKey, selectionKey) => {
        setTodoDraft(null)
        setOpenTodoId('')
        setCollapsedNoteGroups((current) => ({ ...current, [`general:${genomeKey}`]: false }))
        const { tempId } = store.createNote(
            {
                kind: NOTE_TARGET_KIND_GENOME,
                genome_key: genomeKey,
                id: GENERAL_NOTES_TARGET_ID,
                label: 'General notes',
                genome_selection_key: selectionKey || '',
            },
            {
                onIdAssigned: (fromId, toId) => {
                    setOpenNoteId((current) => (current === fromId ? toId : current))
                    if (toId) recordRecentActivity(toId)
                },
            },
        )
        setOpenNoteId(tempId)
        setDetailEditing(true)
        scrollToNotesSection(genomeKey)
    }, [recordRecentActivity, scrollToNotesSection, store])

    const handleStartTodo = useCallback(() => {
        setOpenNoteId('')
        setOpenTodoId('')
        setTodoDraft({
            title: '',
            body: '',
            tags: [],
            status: 'backlog',
            priority: 'medium',
            completed: false,
        })
        setDetailEditing(true)
        scrollToNotesSection(TODO_GENOME_KEY)
    }, [scrollToNotesSection])

    const handleCreateTodo = useCallback(() => {
        const title = todoDraft?.title?.trim()
        if (!title) return
        const nextOrder = todoNotes.reduce((max, note) => Math.max(max, Number(note.todoOrder) || 0), 0) + 1024
        const { tempId } = store.createNote(
            {
                kind: NOTE_TARGET_KIND_TODO,
                genome_key: TODO_GENOME_KEY,
                id: TODO_TARGET_ID,
                label: 'Todo',
                genome_selection_key: '',
            },
            {
                title,
                body: todoDraft.body,
                tags: todoDraft.tags,
                status: todoDraft.status,
                priority: todoDraft.priority,
                completed: todoDraft.status === 'completed',
                todoOrder: nextOrder,
                onIdAssigned: (fromId, toId) => {
                    setOpenTodoId((current) => (current === fromId ? toId : current))
                    if (toId) recordRecentActivity(toId)
                },
            },
        )
        setTodoDraft(null)
        setOpenTodoId(tempId)
    }, [recordRecentActivity, store, todoDraft, todoNotes])

    const handleToggleTodoCompleted = useCallback((note) => {
        if (!note?.id) return
        const completed = !(note.completed || note.status === 'completed')
        store.updateNoteFields(note.id, {
            status: completed ? 'completed' : 'in_progress',
            completed,
            completedAt: completed ? new Date().toISOString() : '',
        })
    }, [store])

    const handleTodoDrop = useCallback((targetNote) => {
        const dragged = todoNotes.find((note) => note.id === draggedTodoId)
        if (todoSortMode !== 'manual' || !dragged || !targetNote) {
            setDraggedTodoId('')
            return
        }
        for (const { note, todoOrder } of reorderTodos(todoNotes, dragged.id, targetNote.id)) {
            if (note.todoOrder !== todoOrder) store.updateNoteFields(note.id, { todoOrder })
        }
        setDraggedTodoId('')
    }, [draggedTodoId, store, todoNotes, todoSortMode])

    /**
     * Open a gene in the genome browser.
     *
     * The note only carries an id and a symbol, but the handoff needs
     * coordinates, so the gene is resolved against that genome first. The same
     * endpoint takes transcript ids, which is why it is also what search uses.
     */
    const handleViewInBrowser = useCallback(async (section, geneRow) => {
        const genome = section.genome
        if (!genome?.browsable) return
        setBusyGenomeKey(section.genomeKey)
        try {
            const params = new URLSearchParams({ genome: genome.selectionKey, query: geneRow.geneId })
            const res = await fetch(`/api/resolve_id?${params.toString()}`)
            if (!res.ok) throw new Error('resolve failed')
            const payload = await res.json()
            const gene = payload?.gene
            if (!gene?.id) throw new Error('no gene')
            // Set the focus before switching: the browser seeds its navigation
            // from this while it is still the hidden view.
            onGenomeFocusGeneSelect?.(genome.selectionKey, gene)
            onNavigateToBrowser?.(genome.selectionKey)
        } catch {
            // Left where they are rather than dropped into an empty browser.
        } finally {
            setBusyGenomeKey('')
        }
    }, [onGenomeFocusGeneSelect, onNavigateToBrowser])

    /** Pull a locally available genome back into the active top-bar set. */
    const handleAddGenome = useCallback(async (genomeKey) => {
        if (!onAddGenome) return
        const match = localGenomeRecords.find((item) => genomeKeysMatch(item, genomeKey))
        if (!match) return

        // Adding can move this section ahead of the other note-only genomes.
        // Keep the section's top edge at the same visual position so the thing
        // the user acted on never jumps out from under them.
        const scrollContainer = scrollContainerRef.current
        const sectionBefore = genomeSectionRefs.current.get(genomeKey)
        const containerTop = scrollContainer?.getBoundingClientRect().top || 0
        const sectionTopBefore = sectionBefore?.getBoundingClientRect().top
        setBusyGenomeKey(genomeKey)
        try {
            const result = await onAddGenome(match)
            if (result?.ok === false || !scrollContainer || sectionTopBefore == null) return
            window.requestAnimationFrame(() => {
                window.requestAnimationFrame(() => {
                    const sectionAfter = genomeSectionRefs.current.get(genomeKey)
                    if (!sectionAfter) return
                    const sectionTopAfter = sectionAfter.getBoundingClientRect().top
                    const relativeBefore = sectionTopBefore - containerTop
                    const relativeAfter = sectionTopAfter - (scrollContainer.getBoundingClientRect().top || 0)
                    scrollContainer.scrollTop += relativeAfter - relativeBefore
                })
            })
        } catch {
            // Nothing added; the section stays where it is with its control intact.
        } finally {
            setBusyGenomeKey('')
        }
    }, [localGenomeRecords, onAddGenome])

    const handleRedownloadGenome = useCallback((genomeKey) => {
        onRedownloadGenome?.(genomeKey)
    }, [onRedownloadGenome])

    const toggleSection = useCallback((genomeKey) => {
        setCollapsedSections((prev) => ({ ...prev, [genomeKey]: !prev[genomeKey] }))
    }, [])

    const toggleNoteGroup = useCallback((groupKey) => {
        setCollapsedNoteGroups((current) => ({ ...current, [groupKey]: !current[groupKey] }))
    }, [])

    const saveState = store.saveStateFor(openNoteId)
    const indicator = saveIndicatorLabel(saveState)
    const canSave = saveState === NOTE_SAVE_STATES.DIRTY
        || saveState === NOTE_SAVE_STATES.ERROR
        || saveState === NOTE_SAVE_STATES.CONFLICT

    const todoSaveState = store.saveStateFor(openTodoId)
    const todoIndicator = saveIndicatorLabel(todoSaveState)
    const todoCanSave = Boolean(openTodo?.title?.trim()) && (todoSaveState === NOTE_SAVE_STATES.DIRTY
        || todoSaveState === NOTE_SAVE_STATES.ERROR
        || todoSaveState === NOTE_SAVE_STATES.CONFLICT)
    const updateTodoEditor = (patch) => {
        if (todoDraft) setTodoDraft((current) => ({ ...current, ...patch }))
        else if (openTodoId) {
            if (Object.hasOwn(patch, 'title') && !String(patch.title || '').trim()) return
            store.updateNoteFields(openTodoId, patch)
        }
    }
    const updateTodoStatus = (status) => {
        const completed = status === 'completed'
        updateTodoEditor({
            status,
            completed,
            completedAt: completed ? new Date().toISOString() : '',
        })
    }

    const openNoteGenome = openNote
        ? activeGenomes.find((g) => g.notesGenomeKey === normalizeNoteGenomeKey(openNote.target?.genome_key))
        : null
    const deletableGenomeNoteIds = currentNotes.filter((note) => !note.pending).map((note) => note.id)
    const deletableTodoIds = todoNotes.filter((note) => !note.pending).map((note) => note.id)
    const deletableCurrentNoteIds = [...deletableGenomeNoteIds, ...deletableTodoIds]
    const totalLoadedNotes = activeGenomeNotes.length + archivedGenomeNotes.length + activeTodoNotes.length + archivedTodoNotes.length
    const noteSetLabel = showingArchived ? 'archived' : 'active'
    const openNoteSectionIndex = openNote
        ? sections.findIndex((section) => section.genomeKey === normalizeNoteGenomeKey(openNote.target?.genome_key))
        : -1
    const detailGridRow = openNoteSectionIndex >= 0 ? openNoteSectionIndex + 2 : 1

    const handlePreviewTodo = (note, edit = false) => {
        if (openTodoId === note.id) {
            if (edit) {
                recordRecentActivity(note.id)
                setDetailEditing(true)
                return
            }
            handleCloseTodo()
            return
        }
        setOpenNoteId('')
        setTodoDraft(null)
        setOpenTodoId(note.id)
        setDetailEditing(edit)
        recordRecentActivity(note.id)
        scrollToNotesSection(TODO_GENOME_KEY)
    }

    const handlePreviewNote = (note, edit = false) => {
        if (openNoteId === note.id) {
            if (edit) {
                recordRecentActivity(note.id)
                setDetailEditing(true)
                return
            }
            handleCloseNote()
            return
        }
        setTodoDraft(null)
        setOpenTodoId('')
        setOpenNoteId(note.id)
        setDetailEditing(edit)
        recordRecentActivity(note.id)
        scrollToNotesSection(normalizeNoteGenomeKey(note.target?.genome_key))
    }

    const renderTodoRows = (notes) => notes.map((note) => {
        const manual = todoSortMode === 'manual' && !hasFilters
        const noteHasConflict = store.saveStateFor(note.id) === NOTE_SAVE_STATES.CONFLICT
        return (
            <div
                key={note.id}
                draggable={manual && !note.pending}
                onDragStart={(event) => {
                    if (!manual) return
                    setDraggedTodoId(note.id)
                    event.dataTransfer.effectAllowed = 'move'
                }}
                onDragEnd={() => setDraggedTodoId('')}
                onDragOver={(event) => {
                    if (manual) event.preventDefault()
                }}
                onDrop={(event) => {
                    event.preventDefault()
                    handleTodoDrop(note)
                }}
                className={`group flex items-center gap-2 px-3 py-2 border-t first:border-t-0 transition-all ${draggedTodoId === note.id ? 'opacity-40' : ''}`}
                style={{
                    borderColor: dividerColor,
                    backgroundColor: note.id === openTodoId ? (isLight ? '#dbe4ff' : '#2b3a55') : undefined,
                }}
            >
                <span
                    className={`flex-none ${manual ? 'cursor-grab opacity-45 group-hover:opacity-80' : 'opacity-20'}`}
                    title={manual
                        ? 'Drag to reorder this task'
                        : (hasFilters ? 'Clear filters to reorder tasks' : 'Choose Manual order to drag tasks')}
                >
                    <DragGlyph />
                </span>
                <button
                    type="button"
                    onClick={() => handlePreviewTodo(note)}
                    className="min-w-0 flex-1 text-left"
                    title={`Open task: ${note.title}`}
                    aria-pressed={note.id === openTodoId}
                >
                    <span className={`block truncate text-sm font-medium ${showingArchived
                        ? `${textSecondary} opacity-75`
                        : (note.completed ? `${textSecondary} line-through` : textPrimary)}`}>
                        {note.title}
                    </span>
                    <PreviewTagChips tags={note.tags} isLight={isLight} archived={showingArchived} />
                </button>
                <span className={`${workflowTagClass} ${statusTagClass(note.status)}`} title={`Status: ${todoLabel(TODO_STATUSES, note.status)}`}>
                    {todoLabel(TODO_STATUSES, note.status)}
                </span>
                <span className={`${workflowTagClass} ${priorityTagClass(note.priority)}`} title={`Priority: ${todoLabel(TODO_PRIORITIES, note.priority)}`}>
                    {todoLabel(TODO_PRIORITIES, note.priority)}
                </span>
                <span className={`${detailOpen ? 'hidden' : 'flex-none w-20'} text-right text-[10px] ${textSecondary}`}>
                    {noteTimestampLabel(note.completedAt || note.updatedAt)}
                </span>
                <div className="grid w-[112px] flex-none grid-cols-4 place-items-center">
                    <button
                        type="button"
                        onClick={() => handleToggleTodoCompleted(note)}
                        disabled={showingArchived || note.pending}
                        className={iconActionClass}
                        style={{ color: note.completed ? '#22c55e' : (isLight ? '#9ca3af' : '#94a3b8') }}
                        title={showingArchived
                            ? 'Restore this task before changing its progress'
                            : (note.completed ? 'Set progress to In progress' : 'Set progress to Completed')}
                        aria-label={note.completed ? `Set ${note.title} to In progress` : `Set ${note.title} to Completed`}
                    >
                        <CompleteGlyph />
                    </button>
                    <button
                        type="button"
                        onClick={() => handlePreviewTodo(note, true)}
                        disabled={showingArchived || note.pending}
                        className={iconActionClass}
                        style={{ color: accentColor }}
                        title={showingArchived ? 'Restore this task before editing it' : `Open and edit ${note.title}`}
                        aria-label={`Open and edit ${note.title}`}
                        aria-pressed={note.id === openTodoId}
                    >
                        <EditGlyph />
                    </button>
                    <button
                        type="button"
                        onClick={() => handleArchiveNotes([note.id], !showingArchived, `todo:${note.id}`)}
                        disabled={Boolean(archiveBusyKey) || note.pending || noteHasConflict}
                        className={iconActionClass}
                        style={{ color: archiveActionColor }}
                        title={noteHasConflict
                            ? 'Resolve the changed version before moving this task'
                            : (showingArchived ? 'Restore this task' : 'Archive this task')}
                        aria-label={showingArchived ? `Restore ${note.title}` : `Archive ${note.title}`}
                    >
                        <ArchiveGlyph restore={showingArchived} />
                    </button>
                    <button
                        type="button"
                        onClick={() => handleDelete(note.id)}
                        className={confirmingDeleteId === note.id
                            ? 'flex-none h-7 px-1 text-[10px] font-semibold transition-opacity hover:opacity-80'
                            : iconActionClass}
                        style={{ color: dangerColor }}
                        title={confirmingDeleteId === note.id ? 'Delete this task for good' : 'Delete this task'}
                    >
                        {confirmingDeleteId === note.id ? 'Confirm' : <TrashGlyph />}
                    </button>
                </div>
            </div>
        )
    })

    const renderGenomeNoteRows = (notes) => sortNotes(notes.filter((note) => (
        Boolean(note.archived) === showingArchived
        && (!hasFilters || visibleNoteIds.has(note.id))
    )), 'updated_desc').map((note) => {
        const active = note.id === openNoteId
        const noteHasConflict = store.saveStateFor(note.id) === NOTE_SAVE_STATES.CONFLICT
        return (
            <div key={note.id} className="group flex items-center gap-2 border-t py-0.5 first:border-t-0" style={{ borderColor: dividerColor }}>
                <button
                    type="button"
                    onClick={() => handlePreviewNote(note)}
                    className={`min-w-0 flex-1 rounded px-2 py-1 text-left transition-colors ${rowHoverClass}`}
                    style={active ? { backgroundColor: isLight ? '#dbe4ff' : '#2b3a55' } : undefined}
                    title="Open this note"
                    aria-pressed={active}
                >
                    <span className="flex min-w-0 items-baseline gap-2">
                        <span className={`min-w-0 flex-1 truncate text-xs ${showingArchived ? `${textSecondary} opacity-75` : textPrimary}`}>{noteDisplayTitle(note)}</span>
                        <span className={`flex-none text-[10px] ${textSecondary}`}>
                            {noteTimestampLabel(note.updatedAt) || noteTimestampLabel(note.createdAt)}
                        </span>
                    </span>
                    <PreviewTagChips tags={note.tags} isLight={isLight} archived={showingArchived} />
                </button>
                <div className="grid w-[84px] flex-none grid-cols-3 place-items-center">
                    <button
                        type="button"
                        onClick={() => handlePreviewNote(note, true)}
                        disabled={showingArchived || note.pending}
                        className={iconActionClass}
                        style={{ color: accentColor }}
                        title={showingArchived ? 'Restore this note before editing it' : 'Open and edit this note'}
                        aria-label="Open and edit this note"
                        aria-pressed={active}
                    >
                        <EditGlyph />
                    </button>
                    <button
                        type="button"
                        onClick={() => handleArchiveNotes([note.id], !showingArchived, `note:${note.id}`)}
                        disabled={Boolean(archiveBusyKey) || note.pending || noteHasConflict}
                        className={iconActionClass}
                        style={{ color: archiveActionColor }}
                        title={noteHasConflict
                            ? 'Resolve the changed version before moving this note'
                            : (showingArchived ? 'Restore this note' : 'Archive this note')}
                        aria-label={showingArchived ? 'Restore this note' : 'Archive this note'}
                    >
                        <ArchiveGlyph restore={showingArchived} />
                    </button>
                    <button
                        type="button"
                        onClick={() => handleDelete(note.id)}
                        className={confirmingDeleteId === note.id
                            ? 'flex-none h-7 px-1.5 text-[10px] font-semibold transition-opacity hover:opacity-80'
                            : iconActionClass}
                        style={{ color: dangerColor }}
                        title={confirmingDeleteId === note.id ? 'Delete this note for good' : 'Delete this note'}
                    >
                        {confirmingDeleteId === note.id ? 'Confirm' : <TrashGlyph />}
                    </button>
                </div>
            </div>
        )
    })

    const detailIsTodo = Boolean(todoEditorNote)
    const detailItem = detailIsTodo ? todoEditorNote : openNote
    const detailSaveState = detailIsTodo ? todoSaveState : saveState
    const detailIndicator = detailIsTodo ? todoIndicator : indicator
    const detailCanSave = detailIsTodo ? todoCanSave : canSave
    const detailId = detailIsTodo ? openTodoId : openNoteId
    const detailEditable = Boolean(todoDraft) || detailEditing

    const toggleTagFilter = (label) => {
        const key = tagKey(label)
        const existing = tagCatalogue.find((tag) => tag.key === key)
        setSelectedTags((current) => {
            const normalized = normalizeNoteTags(current)
            return normalized.some((tag) => tagKey(tag) === key)
                ? normalized.filter((tag) => tagKey(tag) !== key)
                : [...normalized, existing?.label || label]
        })
    }

    const updateDetailTags = (tags) => {
        const nextTags = normalizeNoteTags(tags)
        if (todoDraft) {
            updateTodoEditor({ tags: nextTags })
            return
        }
        store.updateNoteFields(detailId, {
            tags: nextTags,
            tagsUpdatedAt: new Date().toISOString(),
        })
    }

    const handleRecentActivityClick = (note) => {
        const nextSet = note.archived ? 'archived' : 'active'
        if (nextSet !== noteSet) {
            setBulkDeleteRequest(null)
            setNoteSet(nextSet)
        }
        if (note.target?.kind === NOTE_TARGET_KIND_TODO) handlePreviewTodo(note)
        else handlePreviewNote(note)
    }

    const activityPanel = (
        <>
            <PanelModeHeader
                mode={idlePanelMode}
                onModeChange={setIdlePanelMode}
                expanded={idlePanelExpanded}
                onToggleExpanded={() => setIdlePanelExpanded((current) => !current)}
                count={visibleActivity.length}
                isLight={isLight}
                accentColor={accentColor}
                dividerColor={dividerColor}
                textPrimary={textPrimary}
                textSecondary={textSecondary}
                rowHoverClass={rowHoverClass}
            />
            <div data-notes-detail-scroll className="min-h-0 flex-1 overflow-y-auto themed-scrollbar">
                {visibleActivity.length === 0 ? (
                    <div className={`flex flex-col items-center justify-center gap-2 px-6 py-8 text-center ${textSecondary}`}>
                        <NoteGlyph size={22} knockout={isLight ? '#ffffff' : '#1a2232'} />
                        <p className="text-sm">{idlePanelMode === 'edited'
                            ? 'Edited notes and tasks will appear here'
                            : (idlePanelMode === 'viewed'
                                ? 'Viewed notes and tasks will appear here'
                                : 'Viewed and edited notes and tasks will appear here')}</p>
                    </div>
                ) : visibleActivity.map(({ note }) => {
                    const isTodo = note.target?.kind === NOTE_TARGET_KIND_TODO
                    const genomeKey = normalizeNoteGenomeKey(note.target?.genome_key)
                    const topBarGenome = activeGenomes.find((candidate) => candidate.notesGenomeKey === genomeKey) || null
                    const genome = topBarGenome || availableLocalGenomes.find(
                        (candidate) => genomeKeysMatch(candidate.species, genomeKey),
                    ) || null
                    const inTopBar = Boolean(topBarGenome)
                    const fallbackLabels = fallbackGenomePillLabels(genomeKey)
                    const pillActive = inTopBar && Boolean(genome?.active)
                    const pillColor = genome?.color || (isLight ? '#cbd5e1' : '#475569')
                    const pillBackground = pillActive ? pillColor : (isLight ? '#ffffff' : '#1E2938')
                    const pillText = pillActive ? '#ffffff' : (isLight ? '#4b5563' : '#9ca3af')
                    const pillBorder = pillActive ? pillColor : (isLight ? '#d1d5db' : '#4b5563')
                    const contextLabel = note.target?.kind === NOTE_TARGET_KIND_GENOME
                        ? 'General notes'
                        : (note.target?.label || note.target?.id || 'Unknown gene')
                    const contextId = note.target?.kind === NOTE_TARGET_KIND_GENE
                        && note.target?.id
                        && note.target.id !== contextLabel
                        ? note.target.id
                        : ''
                    const preview = recentNotePreview(note)

                    return (
                        <button
                            key={note.id}
                            type="button"
                            onClick={() => handleRecentActivityClick(note)}
                            className={`flex h-[78px] w-full flex-col justify-center border-b px-3 py-2.5 text-left transition-colors last:border-b-0 lg:pl-[46px] ${rowHoverClass} ${note.archived ? 'opacity-70' : ''}`}
                            style={{ borderColor: dividerColor }}
                            title={`Open ${isTodo ? 'task' : 'note'}`}
                        >
                            {isTodo ? (
                                <div className="flex min-w-0 items-baseline gap-2">
                                    <span className="flex-none text-sm font-semibold" style={{ color: accentColor }}>Todo list</span>
                                    <span className={`min-w-0 flex-1 truncate text-xs font-medium ${textPrimary}`}>{note.title || 'Untitled task'}</span>
                                </div>
                            ) : (
                                <div className="flex min-w-0 items-center gap-2">
                                    <div className="relative w-[180px] flex-none" style={{ paddingBottom: 8 }}>
                                        <GenomePill
                                            displayName={genome?.name || fallbackLabels.displayName}
                                            displayAssembly={genome?.assemblyName || fallbackLabels.displayAssembly}
                                            badge={genome?.labels?.badge}
                                            badgeTooltip={genome?.labels?.badgeTooltip}
                                            tooltip={genome?.labels?.pillTooltip || fallbackLabels.tooltip}
                                            isLight={isLight}
                                            width="180px"
                                            minWidth="180px"
                                            maxWidth="180px"
                                            backgroundColor={pillBackground}
                                            textColor={pillText}
                                            borderColor={pillBorder}
                                            borderStyle={inTopBar ? 'solid' : 'dashed'}
                                        />
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        <div className={`truncate text-xs font-semibold ${textPrimary}`}>{contextLabel}</div>
                                        {contextId && <div className={`truncate font-mono text-[10px] ${textSecondary}`}>{contextId}</div>}
                                    </div>
                                </div>
                            )}
                            {preview && (
                                <div className={`mt-1 truncate text-[11px] ${textSecondary}`} title={preview}>{preview}</div>
                            )}
                        </button>
                    )
                })}
            </div>
        </>
    )

    const taggedItemCount = allStoredNotes.filter((note) => normalizeNoteTags(note.tags).length > 0).length
    const tagsPanel = (
        <>
            <PanelModeHeader
                mode={idlePanelMode}
                onModeChange={setIdlePanelMode}
                expanded={idlePanelExpanded}
                onToggleExpanded={() => setIdlePanelExpanded((current) => !current)}
                count={tagCatalogue.length}
                subtitle={`${taggedItemCount} tagged item${taggedItemCount === 1 ? '' : 's'}`}
                isLight={isLight}
                accentColor={accentColor}
                dividerColor={dividerColor}
                textPrimary={textPrimary}
                textSecondary={textSecondary}
                rowHoverClass={rowHoverClass}
            />
            <div className="flex flex-none items-center gap-2 border-b px-3 py-2" style={{ borderColor: dividerColor }}>
                <div className={`flex min-w-0 flex-1 items-center gap-2 rounded-md border px-2 ${isLight ? 'border-slate-300 bg-white' : 'border-slate-600 bg-slate-800'}`}>
                    <TagGlyph size={13} />
                    <input
                        type="text"
                        value={tagCatalogueQuery}
                        onChange={(event) => setTagCatalogueQuery(event.target.value)}
                        placeholder="Find tags…"
                        aria-label="Find tags"
                        className={`h-8 min-w-0 flex-1 bg-transparent text-xs outline-none ${textPrimary}`}
                    />
                    {tagCatalogueQuery && (
                        <button type="button" onClick={() => setTagCatalogueQuery('')} className="text-xs opacity-50 hover:opacity-90" aria-label="Clear tag search">×</button>
                    )}
                </div>
                <select
                    value={tagCatalogueSort}
                    onChange={(event) => setTagCatalogueSort(event.target.value)}
                    className={`h-8 w-[94px] flex-none rounded-md border px-2 text-xs outline-none ${isLight ? 'border-slate-300 bg-white text-slate-700' : 'border-slate-600 bg-slate-800 text-slate-200'}`}
                    aria-label="Sort tags"
                >
                    <option value="popular">Popular</option>
                    <option value="recent">Recent</option>
                    <option value="alphabetical">A–Z</option>
                </select>
            </div>
            <div data-notes-detail-scroll className="min-h-0 flex-1 overflow-y-auto themed-scrollbar">
                {visibleTagCatalogue.length === 0 ? (
                    <div className={`flex flex-col items-center justify-center gap-2 px-6 py-10 text-center ${textSecondary}`}>
                        <TagGlyph size={24} />
                        <p className="text-sm">{tagCatalogue.length === 0 ? 'Tags added to notes and tasks will appear here' : 'No tags match this search'}</p>
                    </div>
                ) : visibleTagCatalogue.map((tag) => {
                    const selected = selectedTags.some((value) => tagKey(value) === tag.key)
                    const contextsOpen = Boolean(expandedTagContexts[tag.key])
                    return (
                        <div key={tag.key} className="border-b last:border-b-0" style={{ borderColor: dividerColor }}>
                            <div className={`flex items-center gap-1 px-2 py-1.5 lg:pl-[46px] ${selected ? (isLight ? 'bg-blue-50' : 'bg-blue-950/35') : ''}`}>
                                <button
                                    type="button"
                                    onClick={() => toggleTagFilter(tag.label)}
                                    className={`flex min-w-0 flex-1 items-center gap-2 rounded px-1.5 py-1 text-left transition-colors ${rowHoverClass}`}
                                    aria-pressed={selected}
                                    title={`${selected ? 'Remove' : 'Add'} ${tag.label} ${selected ? 'from' : 'to'} filters`}
                                >
                                    <TagChip label={tag.label} isLight={isLight} />
                                    <span className={`ml-auto flex-none text-[10px] ${textSecondary}`}>
                                        {tag.totalCount} total · <span className={activeCountClass}>{tag.activeCount} active</span>
                                        {' · '}
                                        <span className={archivedCountClass}>{tag.archivedCount} archived</span>
                                    </span>
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setExpandedTagContexts((current) => ({ ...current, [tag.key]: !current[tag.key] }))}
                                    className={collapseArrowClass}
                                    aria-expanded={contextsOpen}
                                    title={contextsOpen ? `Hide usage for ${tag.label}` : `Show usage for ${tag.label}`}
                                >
                                    <Chevron open={contextsOpen} size={12} />
                                </button>
                            </div>
                            {contextsOpen && (
                                <div className={`space-y-1 px-4 pb-2 pt-0.5 ${isLight ? 'bg-slate-50/60' : 'bg-slate-900/20'}`}>
                                    {tag.contexts.map((context) => {
                                        const genomeKey = normalizeNoteGenomeKey(context.genomeKey)
                                        const genome = context.kind === 'genome'
                                            ? (activeGenomes.find((candidate) => candidate.notesGenomeKey === genomeKey)
                                                || availableLocalGenomes.find((candidate) => genomeKeysMatch(candidate.species, genomeKey)))
                                            : null
                                        const fallback = context.kind === 'genome' ? fallbackGenomePillLabels(genomeKey) : null
                                        const label = context.kind === 'todo' ? 'Todo list' : (genome?.name || fallback?.displayName || genomeKey)
                                        const assembly = context.kind === 'genome' ? (genome?.assemblyName || fallback?.displayAssembly || '') : ''
                                        return (
                                            <div key={context.key} className="flex items-center gap-2 py-1">
                                                <span className="w-4 flex-none" style={{ color: accentColor }}>{context.kind === 'todo' ? <TagGlyph size={12} /> : <NoteGlyph size={12} knockout={isLight ? '#ffffff' : '#1a2232'} />}</span>
                                                <span className={`min-w-0 flex-1 truncate text-xs ${textPrimary}`} title={assembly ? `${label} · ${assembly}` : label}>
                                                    <span className="font-semibold">{label}</span>{assembly ? ` · ${assembly}` : ''}
                                                </span>
                                                <span className={`flex-none text-[10px] ${textSecondary}`}>{context.totalCount} total · {context.activeCount} active · {context.archivedCount} archived</span>
                                            </div>
                                        )
                                    })}
                                </div>
                            )}
                        </div>
                    )
                })}
            </div>
        </>
    )

    const detailPanel = !detailItem ? (
        idlePanelMode === 'tags' ? tagsPanel : activityPanel
    ) : (
        <>
            <div className="flex min-h-[58px] items-center gap-2 border-b px-3 py-2.5" style={{ borderColor: dividerColor }}>
                <span className={`min-w-0 truncate text-[13px] ${textSecondary}`}>
                    {todoDraft
                        ? 'New task'
                        : (noteTimestampLabel(detailItem.updatedAt) || noteTimestampLabel(detailItem.createdAt))}
                </span>
                {!todoDraft && (
                    <span
                        className="ml-auto flex-none text-[11px]"
                        style={{ color: (detailSaveState === NOTE_SAVE_STATES.ERROR || detailSaveState === NOTE_SAVE_STATES.CONFLICT) ? dangerColor : undefined }}
                        aria-live="polite"
                    >
                        {detailIndicator}
                    </span>
                )}
                {detailEditable ? (
                    <button
                        type="button"
                        onClick={todoDraft
                            ? handleCreateTodo
                            : () => {
                                recordRecentActivity(detailId)
                                store.saveNote(detailId, { force: detailSaveState === NOTE_SAVE_STATES.CONFLICT })
                            }}
                        disabled={todoDraft ? !todoDraft.title.trim() : !detailCanSave}
                        className={`flex-none h-8 px-3 text-xs font-semibold rounded-md transition-opacity ${(todoDraft ? todoDraft.title.trim() : detailCanSave) ? 'hover:opacity-85' : 'opacity-40 cursor-default'}`}
                        style={{ backgroundColor: (todoDraft ? todoDraft.title.trim() : detailCanSave) ? accentColor : 'transparent', color: (todoDraft ? todoDraft.title.trim() : detailCanSave) ? '#ffffff' : undefined }}
                    >
                        {todoDraft ? 'Create task' : (detailSaveState === NOTE_SAVE_STATES.CONFLICT ? 'Keep mine' : 'Save')}
                    </button>
                ) : (
                    <button
                        type="button"
                        onClick={() => {
                            recordRecentActivity(detailId)
                            setDetailEditing(true)
                        }}
                        disabled={showingArchived}
                        className={`${iconActionClass} !h-8 !w-8`}
                        style={{ color: accentColor }}
                        title={showingArchived
                            ? `Restore this ${detailIsTodo ? 'task' : 'note'} before editing it`
                            : `Edit this ${detailIsTodo ? 'task' : 'note'}`}
                        aria-label={`Edit this ${detailIsTodo ? 'task' : 'note'}`}
                    >
                        <EditGlyph size={20} />
                    </button>
                )}
                {!todoDraft && (
                    <button
                        type="button"
                        onClick={() => handleArchiveNotes([detailId], !showingArchived, `${detailIsTodo ? 'todo' : 'note'}:${detailId}`)}
                        disabled={Boolean(archiveBusyKey) || detailItem.pending || detailSaveState === NOTE_SAVE_STATES.CONFLICT}
                        className={`${iconActionClass} !h-8 !w-8`}
                        style={{ color: archiveActionColor }}
                        title={detailSaveState === NOTE_SAVE_STATES.CONFLICT
                            ? `Resolve the changed version before moving this ${detailIsTodo ? 'task' : 'note'}`
                            : (showingArchived ? `Restore this ${detailIsTodo ? 'task' : 'note'}` : `Archive this ${detailIsTodo ? 'task' : 'note'}`)}
                        aria-label={showingArchived ? `Restore this ${detailIsTodo ? 'task' : 'note'}` : `Archive this ${detailIsTodo ? 'task' : 'note'}`}
                    >
                        <ArchiveGlyph restore={showingArchived} size={20} />
                    </button>
                )}
                {!todoDraft && (
                    <button
                        type="button"
                        onClick={() => handleDelete(detailId)}
                        className={confirmingDeleteId === detailId
                            ? 'flex-none h-8 px-1.5 text-xs transition-opacity hover:opacity-80'
                            : `${iconActionClass} !h-8 !w-8`}
                        style={{ color: dangerColor }}
                        title={confirmingDeleteId === detailId
                            ? `Delete this ${detailIsTodo ? 'task' : 'note'} for good`
                            : `Delete this ${detailIsTodo ? 'task' : 'note'}`}
                    >
                        {confirmingDeleteId === detailId ? 'Confirm delete' : <TrashGlyph size={20} />}
                    </button>
                )}
                <button
                    type="button"
                    onClick={handleCloseDetail}
                    className={`${iconActionClass} !h-8 !w-8`}
                    style={{ color: accentColor }}
                    title={`Close ${detailIsTodo ? 'task' : 'note'}`}
                    aria-label={`Close ${detailIsTodo ? 'task' : 'note'}`}
                >
                    <CloseGlyph size={19} />
                </button>
            </div>

            {detailSaveState === NOTE_SAVE_STATES.CONFLICT && !todoDraft && detailEditable && (
                <div className={`flex-none flex items-center gap-2 px-3 py-1.5 text-[11px] ${textPrimary}`} style={{ backgroundColor: cardBg }}>
                    <span className="min-w-0">This {detailIsTodo ? 'task' : 'note'} changed somewhere else since you opened it.</span>
                    <button
                        type="button"
                        onClick={() => store.reload({ noteId: detailId })}
                        className="ml-auto flex-none underline underline-offset-2 hover:opacity-85"
                        style={{ color: accentColor }}
                    >
                        Load theirs
                    </button>
                </div>
            )}

            {detailIsTodo && detailEditable && (
                <div className="flex flex-none flex-wrap items-center gap-x-3 gap-y-2 border-b px-3 py-2" style={{ borderColor: dividerColor, backgroundColor: cardBg }}>
                    <label className="inline-flex items-center gap-1.5" htmlFor="todo-editor-status">
                        <span className={`text-[10px] font-semibold uppercase tracking-wide ${textSecondary}`}>Status</span>
                        <ColorDotSelect
                            id="todo-editor-status"
                            value={todoEditorNote.status}
                            items={TODO_STATUSES}
                            onChange={updateTodoStatus}
                            colorForValue={statusDotColor}
                            isLight={isLight}
                            widthClass="w-[124px]"
                        />
                    </label>
                    <label className="inline-flex items-center gap-1.5" htmlFor="todo-editor-priority">
                        <span className={`text-[10px] font-semibold uppercase tracking-wide ${textSecondary}`}>Priority</span>
                        <ColorDotSelect
                            id="todo-editor-priority"
                            value={todoEditorNote.priority}
                            items={TODO_PRIORITIES}
                            onChange={(priority) => updateTodoEditor({ priority })}
                            colorForValue={priorityDotColor}
                            isLight={isLight}
                            widthClass="w-[96px]"
                        />
                    </label>
                    {!todoDraft && (
                        <button
                            type="button"
                            onClick={() => handleToggleTodoCompleted(openTodo)}
                            disabled={showingArchived}
                            className="ml-auto inline-flex h-7 items-center gap-1.5 px-1 text-xs font-semibold transition-opacity hover:opacity-80"
                            style={{ color: openTodo.completed ? '#22c55e' : (isLight ? '#9ca3af' : '#94a3b8') }}
                        >
                            <CompleteGlyph size={15} />
                            {openTodo.completed ? 'Set to In progress' : 'Mark completed'}
                        </button>
                    )}
                </div>
            )}

            {detailEditable && (
                <TagEditor
                    tags={detailItem.tags}
                    onChange={updateDetailTags}
                    catalogue={tagCatalogue}
                    isLight={isLight}
                    accentColor={accentColor}
                />
            )}

            {detailEditable ? (
                <>
                    <input
                        type="text"
                        value={detailItem.title}
                        onChange={(event) => (detailIsTodo
                            ? updateTodoEditor({ title: event.target.value })
                            : store.updateNoteFields(openNoteId, { title: event.target.value }))}
                        placeholder={detailIsTodo ? 'Task title (required)' : 'Title (optional)'}
                        maxLength={200}
                        autoFocus={Boolean(todoDraft)}
                        className={`flex-none w-full px-3 pt-3 pb-1 text-sm font-semibold bg-transparent outline-none ${textPrimary}`}
                    />
                    <textarea
                        value={detailItem.body}
                        onChange={(event) => (detailIsTodo
                            ? updateTodoEditor({ body: event.target.value })
                            : store.updateNoteFields(openNoteId, { body: event.target.value }))}
                        placeholder={detailIsTodo
                            ? 'Add details, links, or acceptance criteria…'
                            : detailItem.target?.kind === NOTE_TARGET_KIND_GENOME
                                ? 'Write anything about this genome…'
                                : 'Write anything about this gene…'}
                        spellCheck
                        className={`flex-1 min-h-[220px] w-full resize-none bg-transparent outline-none themed-scrollbar px-3 pb-3 text-[13px] leading-[1.55] ${textPrimary}`}
                    />
                </>
            ) : (
                <div className="flex-1 min-h-[220px] overflow-y-auto themed-scrollbar px-3 py-3">
                    <h3 className={`text-sm font-semibold ${textPrimary}`}>
                        {detailItem.title || (detailIsTodo ? 'Untitled task' : 'Untitled note')}
                    </h3>
                    {normalizeNoteTags(detailItem.tags).length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                            {normalizeNoteTags(detailItem.tags).map((tag) => (
                                <TagChip key={tagKey(tag)} label={tag} isLight={isLight} muted={showingArchived} />
                            ))}
                        </div>
                    )}
                    <p className={`mt-2 whitespace-pre-wrap text-[13px] leading-[1.55] ${detailItem.body ? textPrimary : textSecondary}`}>
                        {detailItem.body || (detailIsTodo ? 'No task details.' : 'No note text.')}
                    </p>
                    {detailIsTodo && (
                        <div className="mt-4 flex flex-wrap items-center gap-2">
                            <span className={`${workflowTagClass} ${statusTagClass(detailItem.status)}`}>
                                {todoLabel(TODO_STATUSES, detailItem.status)}
                            </span>
                            <span className={`${workflowTagClass} ${priorityTagClass(detailItem.priority)}`}>
                                {todoLabel(TODO_PRIORITIES, detailItem.priority)} priority
                            </span>
                        </div>
                    )}
                </div>
            )}

            {!detailIsTodo && (
                <div className={`flex-none px-3 py-2 border-t text-[11px] truncate ${textSecondary}`} style={{ borderColor: dividerColor }}>
                    <span className="font-semibold">{openNote.target?.label || openNote.target?.id}</span>
                    {openNote.target?.kind === NOTE_TARGET_KIND_GENE && (
                        <>{' · '}<span className="font-mono">{openNote.target?.id}</span></>
                    )}
                    {openNoteGenome?.name ? ` · ${openNoteGenome.name}` : ''}
                </div>
            )}
        </>
    )

    return (
        <div ref={scrollContainerRef} data-screenshot-capture="view" className={`h-full overflow-y-auto themed-scrollbar ${bg}`} style={{ minHeight: 0 }}>
            <div className={`px-6 py-4 border-b ${borderClass} ${contentBg}`}>
                <div className="flex items-center justify-between gap-4 flex-wrap">
                    <div>
                        <h1 className={`text-xl font-bold ${textPrimary}`}>Notes</h1>
                        <p className={`text-sm mt-0.5 ${textSecondary}`}>
                            {store.status === 'loading' && totalLoadedNotes === 0
                                ? 'Loading…'
                                : hasFilters
                                    ? `${totals.notes} of ${currentNotes.length} note${currentNotes.length === 1 ? '' : 's'} · ${visibleTodoNotes.length} of ${todoNotes.length} task${todoNotes.length === 1 ? '' : 's'}`
                                    : totals.notes === 0
                                    ? (todoNotes.length > 0
                                        ? `${todoNotes.length} ${showingArchived ? 'archived ' : ''}task${todoNotes.length === 1 ? '' : 's'} · no genome notes`
                                        : (showingArchived ? 'No archived notes' : 'Notes you write in the genome browser collect here'))
                                    : `${totals.notes} ${showingArchived ? 'archived ' : ''}note${totals.notes === 1 ? '' : 's'} · ${totals.genes} gene${totals.genes === 1 ? '' : 's'} · ${totals.genomes} genome${totals.genomes === 1 ? '' : 's'}`}
                        </p>
                    </div>
                    <div className="flex items-center gap-3 flex-wrap">
                        <div className={`flex items-center p-1 rounded-lg border ${isLight ? 'bg-gray-100 border-gray-300' : 'bg-gray-900 border-gray-600'}`} aria-label="Choose note set">
                            <button
                                type="button"
                                onClick={() => handleNoteSetChange('active')}
                                className={`h-7 px-3 rounded-md text-xs font-semibold transition-colors ${!showingArchived
                                    ? 'bg-[#0077cc] text-white'
                                    : textSecondary}`}
                                aria-pressed={!showingArchived}
                            >
                                Active {activeGenomeNotes.length + activeTodoNotes.length}
                            </button>
                            <button
                                type="button"
                                onClick={() => handleNoteSetChange('archived')}
                                className={`h-7 px-3 rounded-md text-xs font-semibold transition-colors ${showingArchived
                                    ? 'bg-[#0077cc] text-white'
                                    : textSecondary}`}
                                aria-pressed={showingArchived}
                            >
                                Archived {archivedGenomeNotes.length + archivedTodoNotes.length}
                            </button>
                        </div>
                        <div className={`flex items-center gap-2 px-3 py-2 rounded-lg border ${isLight ? 'bg-gray-50 border-gray-300' : 'bg-gray-900 border-gray-600'}`}>
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="opacity-40 shrink-0" aria-hidden="true">
                                <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                            </svg>
                            <input
                                type="text"
                                value={query}
                                onChange={(event) => setQuery(event.target.value)}
                                placeholder="Search notes, tasks, genes, ids or tags…"
                                className={`w-64 bg-transparent outline-none text-sm ${isLight ? 'text-gray-900 placeholder-gray-400' : 'text-gray-100 placeholder-gray-500'}`}
                            />
                            {query && (
                                <button type="button" onClick={() => setQuery('')} className="opacity-40 hover:opacity-70 text-xs" title="Clear search">✕</button>
                            )}
                        </div>
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                onClick={() => setTransferTab('export')}
                                className={transferButtonClass}
                                title="Export notes and tasks to a file"
                            >
                                <TransferGlyph direction="out" /> Export
                            </button>
                            <button
                                type="button"
                                onClick={() => setTransferTab('import')}
                                className={transferButtonClass}
                                title="Import notes and tasks from a file"
                            >
                                <TransferGlyph direction="in" /> Import
                            </button>
                        </div>
                        <button
                            type="button"
                            onClick={() => requestBulkDelete(deletableCurrentNoteIds, `all ${noteSetLabel} notes`)}
                            disabled={deletableCurrentNoteIds.length === 0}
                            className={iconActionClass}
                            style={{ color: dangerColor }}
                            title={deletableCurrentNoteIds.length > 0
                                ? `Delete all ${noteSetLabel} notes`
                                : `No ${noteSetLabel} notes to delete`}
                            aria-label={`Delete all ${noteSetLabel} notes`}
                        >
                            <TrashGlyph />
                        </button>
                    </div>
                </div>
                {selectedTags.length > 0 && (
                    <div className={`mt-3 flex flex-wrap items-center gap-1.5 border-t pt-3 ${borderClass}`} aria-label="Selected tag filters">
                        <span className={`mr-1 inline-flex items-center gap-1 text-xs font-semibold ${textSecondary}`}><TagGlyph size={14} /> Filters</span>
                        {selectedTags.map((tag) => (
                            <TagChip
                                key={tagKey(tag)}
                                label={tag}
                                isLight={isLight}
                                onRemove={() => setSelectedTags((current) => current.filter((value) => tagKey(value) !== tagKey(tag)))}
                            />
                        ))}
                        {selectedTags.length > 1 && (
                            <div className={`ml-1 flex items-center rounded-md border p-0.5 ${isLight ? 'border-slate-300 bg-slate-100' : 'border-slate-600 bg-slate-900'}`} aria-label="Tag match mode">
                                <button type="button" onClick={() => setTagMatchMode('all')} aria-pressed={tagMatchMode === 'all'} className={`h-6 rounded px-2 text-[10px] font-semibold ${tagMatchMode === 'all' ? 'bg-[#0077cc] text-white' : textSecondary}`}>Match all</button>
                                <button type="button" onClick={() => setTagMatchMode('any')} aria-pressed={tagMatchMode === 'any'} className={`h-6 rounded px-2 text-[10px] font-semibold ${tagMatchMode === 'any' ? 'bg-[#0077cc] text-white' : textSecondary}`}>Match any</button>
                            </div>
                        )}
                        <button type="button" onClick={() => setSelectedTags([])} className="ml-1 text-[11px] font-semibold hover:underline" style={{ color: accentColor }}>Clear all</button>
                    </div>
                )}
            </div>

            {store.status === 'error' && (
                <div className={`px-6 py-3 text-sm`} style={{ color: dangerColor }}>
                    {store.error || "Couldn't load notes."}
                    <button type="button" onClick={() => store.reload()} className="ml-2 underline underline-offset-2" style={{ color: accentColor }}>Retry</button>
                </div>
            )}

            {bulkDeleteRequest && (
                <div
                    className={`mx-6 mt-4 flex items-center gap-3 rounded-lg border px-4 py-3 text-sm ${isLight ? 'bg-red-50 border-red-200' : 'bg-red-950/30 border-red-800'}`}
                    role="alert"
                >
                    <TrashGlyph size={16} />
                    <span className={`min-w-0 flex-1 ${textPrimary}`}>
                        Delete {bulkDeleteRequest.label} ({bulkDeleteRequest.noteIds.length})? This cannot be undone.
                    </span>
                    <button
                        type="button"
                        onClick={() => setBulkDeleteRequest(null)}
                        disabled={bulkDeleteBusy}
                        className={`h-7 px-3 rounded text-xs font-semibold transition-colors ${rowHoverClass}`}
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        onClick={confirmBulkDelete}
                        disabled={bulkDeleteBusy}
                        className="h-7 px-3 rounded text-xs font-semibold text-white disabled:opacity-50"
                        style={{ backgroundColor: dangerColor }}
                    >
                        {bulkDeleteBusy ? 'Deleting…' : `Delete ${bulkDeleteRequest.noteIds.length}`}
                    </button>
                </div>
            )}

            <div
                className={`notes-workspace-grid grid grid-cols-1 items-start gap-x-5 gap-y-3 px-6 py-5 ${detailOpen ? 'notes-workspace-open' : (idlePanelExpanded ? 'notes-workspace-recent-expanded' : 'notes-workspace-idle')} ${idlePanelFollowing ? 'notes-detail-following' : ''}`}
                style={{
                    paddingBottom: detailOpen ? '100vh' : undefined,
                    '--notes-detail-fixed-top': `${detailFixedTop}px`,
                }}
            >
                <section ref={todoSectionRef} className={`notes-source-card min-w-0 rounded-xl border ${borderClass} ${contentBg} overflow-hidden`} aria-label="Todo list">
                        <div className="flex min-h-[58px] items-center gap-2 px-3 py-2.5">
                            <h2 className={`flex-none text-sm font-semibold ${textPrimary}`}>Todo list</h2>
                            <div className="flex-1" />
                            <div className="flex flex-none items-center gap-1 text-xs" aria-label={`${activeTodoNotes.length} active tasks, ${archivedTodoNotes.length} archived tasks`}>
                                <span className={activeCountClass}>
                                    {hasFilters && !showingArchived ? `${visibleTodoNotes.length} of ` : ''}{activeTodoNotes.length} active task{activeTodoNotes.length === 1 ? '' : 's'}
                                </span>
                                <span className={textSecondary}>·</span>
                                <span className={archivedCountClass}>
                                    {hasFilters && showingArchived ? `${visibleTodoNotes.length} of ` : ''}{archivedTodoNotes.length} archived task{archivedTodoNotes.length === 1 ? '' : 's'}
                                </span>
                            </div>
                            <div className="relative w-[120px] flex-none">
                                <select
                                    value={todoSortMode}
                                    onChange={(event) => setTodoSortMode(event.target.value)}
                                    className={`${compactSelectCls} w-full appearance-none`}
                                    title="Sort tasks"
                                    aria-label="Sort tasks"
                                >
                                    {TODO_SORT_MODES.map((mode) => <option key={mode.id} value={mode.id}>{mode.label}</option>)}
                                </select>
                                <svg
                                    width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true"
                                    className={`pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 ${textSecondary}`}
                                >
                                    <path d="m2.5 4.5 3.5 3 3.5-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                                </svg>
                            </div>
                            <div className="grid w-[112px] flex-none grid-cols-4 place-items-center">
                                <span className="h-7 w-7" aria-hidden="true" />
                                <button
                                    type="button"
                                    onClick={handleStartTodo}
                                    disabled={showingArchived}
                                    className={iconActionClass}
                                    style={{ color: accentColor }}
                                    title={showingArchived ? 'Switch to Active to add a task' : 'Add task'}
                                    aria-label="Add task"
                                >
                                    <PlusGlyph />
                                </button>
                                <button
                                    type="button"
                                    onClick={() => handleArchiveNotes(deletableTodoIds, !showingArchived, 'todos')}
                                    disabled={Boolean(archiveBusyKey) || deletableTodoIds.length === 0}
                                    className={iconActionClass}
                                    style={{ color: archiveActionColor }}
                                    title={deletableTodoIds.length > 0
                                        ? `${showingArchived ? 'Restore' : 'Archive'} all ${deletableTodoIds.length} ${noteSetLabel} task${deletableTodoIds.length === 1 ? '' : 's'}`
                                        : `No ${noteSetLabel} tasks to ${showingArchived ? 'restore' : 'archive'}`}
                                    aria-label={`${showingArchived ? 'Restore' : 'Archive'} all ${noteSetLabel} tasks`}
                                >
                                    <ArchiveGlyph restore={showingArchived} />
                                </button>
                                <button
                                    type="button"
                                    onClick={() => requestBulkDelete(deletableTodoIds, `all ${noteSetLabel} tasks`)}
                                    disabled={deletableTodoIds.length === 0}
                                    className={iconActionClass}
                                    style={{ color: dangerColor }}
                                    title={deletableTodoIds.length > 0
                                        ? `Delete all ${noteSetLabel} tasks`
                                        : `No ${noteSetLabel} tasks to delete`}
                                    aria-label={`Delete all ${noteSetLabel} tasks`}
                                >
                                    <TrashGlyph />
                                </button>
                            </div>
                        </div>
                        <div className="border-t" style={{ borderColor: dividerColor }}>
                            {sortedTodoNotes.length > 0
                                ? renderTodoRows(sortedTodoNotes)
                                : (
                                    <p className={`px-4 py-3 text-xs ${textSecondary}`}>
                                        {hasFilters ? 'No tasks match the current filters' : `No ${showingArchived ? 'archived' : 'active'} tasks`}
                                    </p>
                                )}
                        </div>
                </section>

                {/* Left: genomes → genes → notes */}
                    {sections.length === 0 && store.status === 'ready' && (!hasFilters || visibleTodoNotes.length === 0) && (
                        <div className={`notes-source-card flex flex-col items-center justify-center h-64 rounded-xl border-2 border-dashed ${isLight ? 'border-gray-200 text-gray-400' : 'border-gray-700 text-gray-500'}`}>
                            <div className="mb-3 opacity-40"><AppButtonIcon buttonId="notes" isLight={isLight} /></div>
                            <p className="text-sm font-medium">{hasFilters ? 'Nothing matches the current filters' : (showingArchived ? 'No archived notes' : 'No notes yet')}</p>
                            <p className="text-xs mt-1 opacity-70">
                                {hasFilters
                                    ? 'Try removing a tag or changing the text search'
                                    : (showingArchived
                                        ? 'Archive a note to move it here without deleting it'
                                        : 'Open a gene in the Genome Browser and use the Notes section in its drawer')}
                            </p>
                        </div>
                    )}

                    {sections.map((section) => {
                        const collapsed = collapsedSections[section.genomeKey]
                        const genome = section.genome
                        const fallbackLabels = fallbackGenomePillLabels(section.genomeKey)
                        const genomeIsInTopBar = section.inTopBar
                        const genomeDataAvailable = Boolean(genome?.species)
                        const swatch = genome?.color || (isLight ? '#cbd5e1' : '#475569')
                        const genomePillActive = genomeIsInTopBar && Boolean(genome?.active)
                        const genomePillBackground = genomePillActive ? swatch : (isLight ? '#ffffff' : '#1E2938')
                        const genomePillText = genomePillActive ? '#ffffff' : (isLight ? '#4b5563' : '#9ca3af')
                        const genomePillBorder = genomePillActive ? swatch : (isLight ? '#d1d5db' : '#4b5563')
                        const genomePillDisplayName = genome?.name || fallbackLabels.displayName
                        const genomePillDisplayAssembly = genome?.assemblyName || fallbackLabels.displayAssembly
                        const genomePillBusy = busyGenomeKey === section.genomeKey
                        const genomePillCanAct = genomeDataAvailable
                            ? Boolean(onAddGenome) && localGenomeLookupReady
                            : Boolean(onRedownloadGenome) && localGenomeLookupReady
                        const scopedGenomeNoteIds = noteIdsForGenome(section.genomeKey)
                        const scopedGeneralNoteIds = noteIdsForGeneral(section.genomeKey)
                        const genomeLabel = genome?.name || section.genomeKey
                        const generalMatchesQuery = !hasFilters || section.generalNotes.some((note) => visibleNoteIds.has(note.id))
                        const showGeneralRow = generalMatchesQuery && (!showingArchived || section.generalArchivedCount > 0)
                        const generalGroupKey = `general:${section.genomeKey}`
                        const generalCollapsed = !hasFilters && Boolean(collapsedNoteGroups[generalGroupKey])
                        return (
                            <section
                                key={section.genomeKey}
                                ref={(node) => {
                                    if (node) genomeSectionRefs.current.set(section.genomeKey, node)
                                    else genomeSectionRefs.current.delete(section.genomeKey)
                                }}
                                className={`notes-source-card min-w-0 rounded-xl border ${borderClass} ${contentBg} overflow-hidden`}
                            >
                                <div className="flex items-center gap-3 px-3 py-2.5">
                                    <button
                                        type="button"
                                        onClick={() => toggleSection(section.genomeKey)}
                                        aria-expanded={!collapsed}
                                        className={collapseArrowClass}
                                        title={collapsed ? 'Show this genome' : 'Hide this genome'}
                                    >
                                        <Chevron open={!collapsed} />
                                    </button>
                                    {/* Fixed to the same 180px genome column used by the
                                        browser toolbar. A dashed edge means the genome is
                                        represented by notes but is not in the top bar. */}
                                    <div className="relative flex-none" style={{ width: 180, paddingBottom: 8 }}>
                                        <GenomePill
                                            displayName={genomePillDisplayName}
                                            displayAssembly={genomePillDisplayAssembly}
                                            badge={genome?.labels?.badge}
                                            badgeTooltip={genome?.labels?.badgeTooltip}
                                            tooltip={genome?.labels?.pillTooltip || fallbackLabels.tooltip}
                                            isLight={isLight}
                                            width="180px"
                                            minWidth="180px"
                                            maxWidth="180px"
                                            paddingLeft={!genomeIsInTopBar ? 31 : undefined}
                                            backgroundColor={genomePillBackground}
                                            textColor={genomePillText}
                                            borderColor={genomePillBorder}
                                            borderStyle={genomeIsInTopBar ? 'solid' : 'dashed'}
                                        >
                                            {!genomeIsInTopBar && (
                                                <button
                                                    type="button"
                                                    onClick={(event) => {
                                                        event.stopPropagation()
                                                        if (genomeDataAvailable) handleAddGenome(section.genomeKey)
                                                        else handleRedownloadGenome(section.genomeKey)
                                                    }}
                                                    disabled={!genomePillCanAct || genomePillBusy}
                                                    className="absolute left-[7px] z-20 flex h-[17px] w-[17px] items-center justify-center rounded-full text-white transition-all hover:scale-110 hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300/70 disabled:scale-100 disabled:opacity-45"
                                                    style={{
                                                        top: 0,
                                                        bottom: 8,
                                                        marginTop: 'auto',
                                                        marginBottom: 'auto',
                                                        backgroundColor: genomeDataAvailable ? accentColor : dangerColor,
                                                    }}
                                                    title={genomeDataAvailable
                                                        ? `Add ${genomePillDisplayName} to the active genomes in the top bar`
                                                        : `Genome data is unavailable; open Downloads to download ${genomePillDisplayName} again`}
                                                    aria-label={genomeDataAvailable
                                                        ? `Add ${genomePillDisplayName} to active genomes`
                                                        : `Redownload ${genomePillDisplayName}`}
                                                >
                                                    {genomePillBusy
                                                        ? <span className="h-2.5 w-2.5 animate-spin rounded-full border border-white/50 border-t-white" />
                                                        : (genomeDataAvailable ? <PlusGlyph size={11} /> : <DownloadGlyph />)}
                                                </button>
                                            )}
                                        </GenomePill>
                                    </div>
                                    <div className="flex-1 min-w-0" />
                                    <span className={`min-w-0 truncate text-right text-xs ${textSecondary}`}>
                                        {section.noteCount === 0
                                            ? 'No notes added yet'
                                            : (
                                                <>
                                                    {section.genes.length > 0 && (
                                                        <>{section.genes.length} gene{section.genes.length === 1 ? '' : 's'} · </>
                                                    )}
                                                    <span className={activeCountClass}>
                                                        {section.activeNoteCount} active note{section.activeNoteCount === 1 ? '' : 's'}
                                                    </span>
                                                    {' · '}
                                                    <span className={archivedCountClass}>
                                                        {section.archivedNoteCount} archived note{section.archivedNoteCount === 1 ? '' : 's'}
                                                    </span>
                                                </>
                                            )}
                                    </span>
                                    <div className="grid w-[84px] flex-none grid-cols-3 place-items-center">
                                        <span className="h-7 w-7" aria-hidden="true" />
                                        <button
                                        type="button"
                                        onClick={() => handleArchiveNotes(
                                            scopedGenomeNoteIds,
                                            !showingArchived,
                                            `genome:${section.genomeKey}`,
                                        )}
                                        disabled={Boolean(archiveBusyKey) || scopedGenomeNoteIds.length === 0}
                                        className={iconActionClass}
                                        style={{ color: archiveActionColor }}
                                        title={scopedGenomeNoteIds.length > 0
                                            ? `${showingArchived ? 'Restore' : 'Archive'} all ${scopedGenomeNoteIds.length} ${showingArchived ? 'archived' : 'active'} note${scopedGenomeNoteIds.length === 1 ? '' : 's'} for ${genomeLabel}`
                                            : `No ${showingArchived ? 'archived' : 'active'} notes to ${showingArchived ? 'restore' : 'archive'} for ${genomeLabel}`}
                                        aria-label={`${showingArchived ? 'Restore' : 'Archive'} all notes for ${genomeLabel}`}
                                        >
                                            <ArchiveGlyph restore={showingArchived} />
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => requestBulkDelete(
                                                scopedGenomeNoteIds,
                                                `notes for ${genomeLabel}`,
                                            )}
                                            disabled={scopedGenomeNoteIds.length === 0}
                                            className={iconActionClass}
                                            style={{ color: dangerColor }}
                                            title={scopedGenomeNoteIds.length > 0
                                                ? `Delete all ${showingArchived ? 'archived' : 'active'} notes for ${genomeLabel}`
                                                : `No ${showingArchived ? 'archived' : 'active'} notes to delete for this genome`}
                                            aria-label={`Delete all notes for ${genomeLabel}`}
                                        >
                                            <TrashGlyph />
                                        </button>
                                    </div>
                                </div>

                                {!collapsed && (showGeneralRow || section.genes.length > 0) && (
                                    <div className="border-t" style={{ borderColor: dividerColor }}>
                                        {showGeneralRow && (
                                            <div className={`px-3 py-2 ${section.genes.length > 0 ? 'border-b' : ''}`} style={{ borderColor: dividerColor }}>
                                                <div className="flex items-center gap-2">
                                                    {section.generalNotes.length > 0 && (
                                                        <button
                                                            type="button"
                                                            onClick={() => toggleNoteGroup(generalGroupKey)}
                                                            className={collapseArrowClass}
                                                            aria-expanded={!generalCollapsed}
                                                            title={generalCollapsed ? 'Show general notes' : 'Hide general notes'}
                                                        >
                                                            <Chevron open={!generalCollapsed} size={12} />
                                                        </button>
                                                    )}
                                                    <span className={`text-sm font-semibold ${textPrimary}`}>General notes</span>
                                                    {section.generalNotes.length > 0 && (
                                                        <>
                                                            <span
                                                                className={`inline-flex items-center gap-1 text-xs ${activeCountClass}`}
                                                                title={`${section.generalActiveCount} active note${section.generalActiveCount === 1 ? '' : 's'}`}
                                                            >
                                                                <NoteGlyph size={12} filled knockout={isLight ? '#ffffff' : '#1a2232'} />
                                                                {section.generalActiveCount}
                                                            </span>
                                                            <span
                                                                className={`inline-flex items-center gap-1 text-xs ${archivedCountClass}`}
                                                                title={`${section.generalArchivedCount} archived note${section.generalArchivedCount === 1 ? '' : 's'}`}
                                                            >
                                                                <ArchiveGlyph size={12} />
                                                                {section.generalArchivedCount}
                                                            </span>
                                                        </>
                                                    )}
                                                    <div className="flex-1" />
                                                    <div className="grid w-[84px] flex-none grid-cols-3 place-items-center">
                                                        <button
                                                            type="button"
                                                            onClick={() => handleCreateGeneral(section.genomeKey, genome?.selectionKey)}
                                                            disabled={showingArchived}
                                                            className={iconActionClass}
                                                            style={{ color: accentColor }}
                                                            title={showingArchived ? 'Switch to Active to add a general note' : `Add a general note for ${genomeLabel}`}
                                                            aria-label={`Add a general note for ${genomeLabel}`}
                                                        >
                                                            <PlusGlyph />
                                                        </button>
                                                        {section.generalNotes.length > 0 ? (
                                                            <button
                                                                type="button"
                                                                onClick={() => handleArchiveNotes(
                                                                    scopedGeneralNoteIds,
                                                                    !showingArchived,
                                                                    `general:${section.genomeKey}`,
                                                                )}
                                                                disabled={Boolean(archiveBusyKey) || scopedGeneralNoteIds.length === 0}
                                                                className={iconActionClass}
                                                                style={{ color: archiveActionColor }}
                                                                title={`${showingArchived ? 'Restore' : 'Archive'} all general notes for ${genomeLabel}`}
                                                                aria-label={`${showingArchived ? 'Restore' : 'Archive'} all general notes for ${genomeLabel}`}
                                                            >
                                                                <ArchiveGlyph restore={showingArchived} />
                                                            </button>
                                                        ) : <span className="h-7 w-7" aria-hidden="true" />}
                                                        {section.generalNotes.length > 0 ? (
                                                            <button
                                                                type="button"
                                                                onClick={() => requestBulkDelete(scopedGeneralNoteIds, `general notes for ${genomeLabel}`)}
                                                                disabled={scopedGeneralNoteIds.length === 0}
                                                                className={iconActionClass}
                                                                style={{ color: dangerColor }}
                                                                title={`Delete all ${showingArchived ? 'archived' : 'active'} general notes for ${genomeLabel}`}
                                                                aria-label={`Delete all general notes for ${genomeLabel}`}
                                                            >
                                                                <TrashGlyph />
                                                            </button>
                                                        ) : <span className="h-7 w-7" aria-hidden="true" />}
                                                    </div>
                                                </div>
                                                {section.generalNotes.length > 0 && !generalCollapsed && (
                                                    <div className="mt-1 space-y-0.5">
                                                        {renderGenomeNoteRows(section.generalNotes)}
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                        {section.genes.map((geneRow) => {
                                            const geneGroupKey = `gene:${section.genomeKey}:${geneRow.geneId}`
                                            const geneCollapsed = !hasFilters && Boolean(collapsedNoteGroups[geneGroupKey])
                                            return (
                                            <div key={geneRow.geneId} className="px-3 py-2 border-b last:border-b-0" style={{ borderColor: dividerColor }}>
                                                <div className="flex items-center gap-2">
                                                    <button
                                                        type="button"
                                                        onClick={() => toggleNoteGroup(geneGroupKey)}
                                                        className={collapseArrowClass}
                                                        aria-expanded={!geneCollapsed}
                                                        title={geneCollapsed ? `Show notes for ${geneRow.label || geneRow.geneId}` : `Hide notes for ${geneRow.label || geneRow.geneId}`}
                                                    >
                                                        <Chevron open={!geneCollapsed} size={12} />
                                                    </button>
                                                    <span className={`text-sm font-semibold ${textPrimary}`}>{geneRow.label || geneRow.geneId}</span>
                                                    <span className={`text-xs font-mono ${textSecondary}`}>{geneRow.geneId}</span>
                                                    <span
                                                        className={`inline-flex items-center gap-1 text-xs ${activeCountClass}`}
                                                        title={`${geneRow.activeCount} active note${geneRow.activeCount === 1 ? '' : 's'}`}
                                                        aria-label={`${geneRow.activeCount} active note${geneRow.activeCount === 1 ? '' : 's'}`}
                                                    >
                                                        <NoteGlyph size={12} filled knockout={isLight ? '#ffffff' : '#1a2232'} />
                                                        {geneRow.activeCount}
                                                    </span>
                                                    <span
                                                        className={`inline-flex items-center gap-1 text-xs ${archivedCountClass}`}
                                                        title={`${geneRow.archivedCount} archived note${geneRow.archivedCount === 1 ? '' : 's'}`}
                                                        aria-label={`${geneRow.archivedCount} archived note${geneRow.archivedCount === 1 ? '' : 's'}`}
                                                    >
                                                        <ArchiveGlyph size={12} />
                                                        {geneRow.archivedCount}
                                                    </span>
                                                    <div className="flex-1" />
                                                    <button
                                                        type="button"
                                                        onClick={() => handleViewInBrowser(section, geneRow)}
                                                        disabled={!genome?.browsable}
                                                        className={iconActionClass}
                                                        style={{ color: accentColor }}
                                                        title={genome?.browsable
                                                            ? `Show ${geneRow.label || geneRow.geneId} in the Genome Browser`
                                                            : 'Add this genome to view it in the browser'}
                                                    >
                                                        {/* Reuse the browser app button's exact mark so
                                                            the action and its destination read alike. */}
                                                        <span className="inline-flex">
                                                            <AppButtonIcon buttonId="genome_browser" isLight={isLight} compact />
                                                        </span>
                                                    </button>
                                                    <div className="grid w-[84px] flex-none grid-cols-3 place-items-center">
                                                        <button
                                                            type="button"
                                                            onClick={() => handleCreate(section.genomeKey, geneRow.geneId, geneRow.label, genome?.selectionKey)}
                                                            disabled={showingArchived}
                                                            className={iconActionClass}
                                                            style={{ color: accentColor }}
                                                            title={showingArchived ? 'Switch to Active to add a note' : `Add a note on ${geneRow.label || geneRow.geneId}`}
                                                        >
                                                            <PlusGlyph />
                                                        </button>
                                                        <button
                                                            type="button"
                                                            onClick={() => handleArchiveNotes(
                                                                noteIdsForGene(section.genomeKey, geneRow.geneId),
                                                                !showingArchived,
                                                                `gene:${section.genomeKey}:${geneRow.geneId}`,
                                                            )}
                                                            disabled={Boolean(archiveBusyKey) || noteIdsForGene(section.genomeKey, geneRow.geneId).length === 0}
                                                            className={iconActionClass}
                                                            style={{ color: archiveActionColor }}
                                                            title={noteIdsForGene(section.genomeKey, geneRow.geneId).length > 0
                                                                ? `${showingArchived ? 'Restore' : 'Archive'} all ${noteIdsForGene(section.genomeKey, geneRow.geneId).length} ${showingArchived ? 'archived' : 'active'} note${noteIdsForGene(section.genomeKey, geneRow.geneId).length === 1 ? '' : 's'} for ${geneRow.label || geneRow.geneId}`
                                                                : `No ${showingArchived ? 'archived' : 'active'} notes to ${showingArchived ? 'restore' : 'archive'} for ${geneRow.label || geneRow.geneId}`}
                                                            aria-label={`${showingArchived ? 'Restore' : 'Archive'} all notes for ${geneRow.label || geneRow.geneId}`}
                                                        >
                                                            <ArchiveGlyph restore={showingArchived} />
                                                        </button>
                                                        <button
                                                            type="button"
                                                            onClick={() => requestBulkDelete(
                                                                noteIdsForGene(section.genomeKey, geneRow.geneId),
                                                                `notes for ${geneRow.label || geneRow.geneId}`,
                                                            )}
                                                            disabled={noteIdsForGene(section.genomeKey, geneRow.geneId).length === 0}
                                                            className={iconActionClass}
                                                            style={{ color: dangerColor }}
                                                            title={noteIdsForGene(section.genomeKey, geneRow.geneId).length > 0
                                                                ? `Delete all ${showingArchived ? 'archived' : 'active'} notes for ${geneRow.label || geneRow.geneId}`
                                                                : `No ${showingArchived ? 'archived' : 'active'} notes to delete for ${geneRow.label || geneRow.geneId}`}
                                                            aria-label={`Delete all notes for ${geneRow.label || geneRow.geneId}`}
                                                        >
                                                            <TrashGlyph />
                                                        </button>
                                                    </div>
                                                </div>

                                                {!geneCollapsed && (
                                                    <div className="mt-1 space-y-0.5">
                                                        {renderGenomeNoteRows(geneRow.notes)}
                                                    </div>
                                                )}
                                            </div>
                                            )
                                        })}
                                    </div>
                                )}
                            </section>
                        )
                    })}

                <div
                    className="notes-detail-slot min-w-0"
                    style={{ '--notes-detail-row': detailGridRow }}
                >
                    <div
                        className={`notes-detail-panel min-w-0 rounded-xl border ${borderClass} ${contentBg} flex flex-col ${detailOpen ? 'min-h-[360px]' : ''}`}
                        style={{ maxHeight: 'calc(100vh - 220px)' }}
                        onWheelCapture={detailOpen ? undefined : handleIdlePanelWheel}
                    >
                        {detailPanel}
                    </div>
                </div>
            </div>

            <NotesTransferModal
                open={Boolean(transferTab)}
                theme={theme}
                notes={allStoredNotes}
                activeGenomes={activeGenomes}
                outputDir={config?.output_dir || ''}
                mode={transferTab || 'export'}
                onImported={() => store.reload()}
                onNotify={(notice) => setTransferNotice({ ...notice, at: Date.now() })}
                onClose={() => setTransferTab('')}
            />

            {transferNotice && (
                <div
                    role="status"
                    className={`fixed bottom-6 left-1/2 z-[210] w-[460px] max-w-[calc(100vw-2rem)] -translate-x-1/2 cursor-pointer rounded-xl border px-4 py-3 text-sm shadow-2xl ${transferNotice.ok
                        ? (isLight ? 'bg-white border-green-300 text-green-800' : 'bg-gray-800 border-green-600/60 text-green-300')
                        : (isLight ? 'bg-white border-red-300 text-red-700' : 'bg-gray-800 border-red-600/60 text-red-400')}`}
                    onClick={() => setTransferNotice(null)}
                    title="Dismiss"
                >
                    <div className="font-semibold">{transferNotice.title}</div>
                    {(transferNotice.lines || []).length > 0 && (
                        <div className="mt-1.5 space-y-0.5 font-mono text-xs">
                            {transferNotice.lines.slice(0, 3).map((line) => (
                                <div key={line} className="truncate">{line}</div>
                            ))}
                        </div>
                    )}
                    {transferNotice.note && (
                        <div className={`mt-1.5 text-xs ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                            {transferNotice.note}
                        </div>
                    )}
                </div>
            )}
        </div>
    )
}

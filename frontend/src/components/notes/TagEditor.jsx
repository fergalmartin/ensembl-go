import { useEffect, useRef, useState } from 'react'
import { MAX_NOTE_TAGS, normalizeNoteTags, normalizeTagText, suggestTags, tagKey } from '../../utils/noteTags.js'
import { TagGlyph } from './noteGlyphs'
import { TagChip } from './TagChips'

export function TagEditor({ tags, onChange, catalogue, isLight, accentColor }) {
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

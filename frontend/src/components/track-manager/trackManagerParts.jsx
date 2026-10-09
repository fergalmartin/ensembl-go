import { useEffect, useMemo, useRef, useState } from 'react'
import { genomeKeysMatch } from '../../utils/genomeIdentity.js'
import { TRACK_TYPES, TYPE_COLORS, genomeDisplayText } from './trackManagerModel.js'

export const IconUpDown = ({ open, size = 12 }) => (
    <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}
    >
        <polyline points="6 9 12 15 18 9" />
    </svg>
)

// ── Sub-components ────────────────────────────────────────────────────────────

export function TypeBadge({ type, small = false }) {
    const color = TYPE_COLORS[type] || '#64748b'
    const label = TRACK_TYPES.find(t => t.id === type)?.label || type
    return (
        <span
            className={`inline-flex items-center rounded font-semibold ${small ? 'text-[10px] px-1.5 py-0.5' : 'text-[11px] px-2 py-0.5'}`}
            style={{ backgroundColor: color + '22', color, border: `1px solid ${color}55` }}
        >
            {label}
        </span>
    )
}

export function EmptyState({ isLight }) {
    return (
        <div className={`flex flex-col items-center justify-center h-64 rounded-xl border-2 border-dashed ${isLight ? 'border-gray-200 text-gray-400' : 'border-gray-700 text-gray-500'}`}>
            <svg className="w-12 h-12 mb-3 opacity-40" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 17v-6M12 17v-2M15 17v-4M5 3h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2z" />
            </svg>
            <p className="text-sm font-medium">No tracks registered yet</p>
            <p className="text-xs mt-1 opacity-70">Click "Add Track" to register your first custom track</p>
        </div>
    )
}

// ── Genome note helper ────────────────────────────────────────────────────────

export function GenomeNote({ genomeKey, genomeOptions, isLight }) {
    if (!genomeKey) return null
    const isKnown = genomeOptions.some(g => genomeKeysMatch(g.key, genomeKey))
    if (isKnown) return null
    return (
        <p className={`text-xs mt-1 ${isLight ? 'text-amber-600' : 'text-amber-400'}`}>
            No local data for this genome — it will be saved, but won't display until a matching genome is added in the Genome Selector.
        </p>
    )
}

export function GenomeComboBox({ value, onChange, genomeOptions, isLight }) {
    const [open, setOpen] = useState(false)
    const [inputValue, setInputValue] = useState(() => genomeDisplayText(value, genomeOptions))
    const boxRef = useRef(null)
    const listRef = useRef(null)

    // Picking a genome shows its name; this used to put the raw key back in the box.
    useEffect(() => {
        setInputValue(genomeDisplayText(value, genomeOptions))
    }, [value, genomeOptions])

    useEffect(() => {
        const handleClick = (e) => {
            if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false)
        }
        document.addEventListener('mousedown', handleClick)
        return () => document.removeEventListener('mousedown', handleClick)
    }, [])

    const filtered = useMemo(() => {
        if (!inputValue) return genomeOptions
        const q = inputValue.toLowerCase()
        return genomeOptions.filter(g =>
            g.label.toLowerCase().includes(q) || g.key.toLowerCase().includes(q)
        )
    }, [inputValue, genomeOptions])

    // The genome field sits at the foot of the Add Track dialog, so its list opened below
    // the visible part of the dialog's scrolling body and had to be scrolled to by hand.
    // Bring it into view as it opens — 'nearest', so nothing moves when it already fits.
    const hasList = open && filtered.length > 0
    useEffect(() => {
        if (!hasList) return undefined
        const frame = requestAnimationFrame(() => {
            listRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
        })
        return () => cancelAnimationFrame(frame)
    }, [hasList])

    return (
        <div ref={boxRef} className="relative">
            <input
                type="text"
                value={inputValue}
                placeholder="Search genomes or type an assembly accession…"
                onFocus={() => setOpen(true)}
                onChange={(e) => {
                    setInputValue(e.target.value)
                    onChange(e.target.value)
                    setOpen(true)
                }}
                className={`w-full px-3 py-2 rounded-lg text-sm border focus:outline-none focus:ring-2 ${isLight
                    ? 'bg-white border-gray-300 text-gray-900 focus:ring-blue-500/40 focus:border-blue-500'
                    : 'bg-gray-700 border-gray-600 text-gray-100 focus:ring-blue-500/40 focus:border-blue-500'}`}
            />
            {open && filtered.length > 0 && (
                <div ref={listRef} className={`absolute z-50 mt-1 w-full rounded-lg shadow-lg border overflow-hidden max-h-52 overflow-y-auto ${isLight ? 'bg-white border-gray-200' : 'bg-gray-800 border-gray-700'}`}>
                    {filtered.map(g => (
                        <button
                            key={g.key}
                            type="button"
                            className={`w-full text-left px-3 py-2 text-sm hover:bg-blue-500/10 ${isLight ? 'text-gray-800' : 'text-gray-200'}`}
                            onMouseDown={(e) => {
                                e.preventDefault()
                                setInputValue(g.label)
                                onChange(g.key)
                                setOpen(false)
                            }}
                        >
                            <span className="font-medium">{g.label}</span>
                            <span className={`ml-2 text-xs opacity-60`}>{g.key}</span>
                        </button>
                    ))}
                </div>
            )}
        </div>
    )
}

export function GroupLayoutIcon({ className = 'w-4 h-4' }) {
    return (
        <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h10" />
        </svg>
    )
}

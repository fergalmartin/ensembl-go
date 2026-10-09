import { useEffect, useRef, useState } from 'react'

export function ColorDotSelect({ id, value, items, onChange, colorForValue, isLight, widthClass }) {
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

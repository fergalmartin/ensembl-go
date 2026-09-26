import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { buildActiveTaskSections } from '../utils/activeDownloads'
import { cancelDownloadTasks, useDownloadTasks } from '../utils/downloadTasksStore'

const MENU_WIDTH = 440
const MENU_GAP = 6

function ProgressRing({ progress, size = 14 }) {
    const stroke = 2
    const radius = (size - stroke) / 2
    const circumference = 2 * Math.PI * radius
    return (
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" className="-rotate-90 flex-shrink-0">
            <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="currentColor" strokeWidth={stroke} opacity="0.25" />
            <circle
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                stroke="currentColor"
                strokeWidth={stroke}
                strokeLinecap="round"
                strokeDasharray={circumference}
                strokeDashoffset={circumference * (1 - Math.max(0.04, Math.min(1, progress)))}
                style={{ transition: 'stroke-dashoffset 0.4s ease' }}
            />
        </svg>
    )
}

/**
 * The top-bar button that appears while anything long-running is under way, and the
 * menu it opens. Downloads are the only kind of task today; each kind is a section.
 */
export default function ActiveTasksButton({ theme = 'dark', onOpenDownloads = null }) {
    const isLight = theme === 'light'
    const tasks = useDownloadTasks()
    const sections = useMemo(() => buildActiveTaskSections(tasks), [tasks])
    const [open, setOpen] = useState(false)
    const [menuPosition, setMenuPosition] = useState(null)
    const [cancellingIds, setCancellingIds] = useState(() => new Set())
    const buttonRef = useRef(null)
    const menuRef = useRef(null)

    const total = sections.reduce((sum, section) => sum + section.total, 0)
    const progress = total > 0
        ? sections.reduce((sum, section) => sum + section.progress * section.total, 0) / total
        : 0
    const visible = total > 0

    useEffect(() => {
        if (!visible) setOpen(false)
    }, [visible])

    const placeMenu = useCallback(() => {
        const rect = buttonRef.current?.getBoundingClientRect()
        if (!rect) return
        const right = Math.max(8, window.innerWidth - rect.right)
        const left = Math.max(8, window.innerWidth - right - MENU_WIDTH)
        setMenuPosition({ top: rect.bottom + MENU_GAP, left })
    }, [])

    useLayoutEffect(() => {
        if (!open) return undefined
        placeMenu()
        window.addEventListener('resize', placeMenu)
        window.addEventListener('scroll', placeMenu, true)
        return () => {
            window.removeEventListener('resize', placeMenu)
            window.removeEventListener('scroll', placeMenu, true)
        }
    }, [open, placeMenu])

    useEffect(() => {
        if (!open) return undefined
        const onPointerDown = (event) => {
            if (menuRef.current?.contains(event.target)) return
            if (buttonRef.current?.contains(event.target)) return
            setOpen(false)
        }
        const onKeyDown = (event) => {
            if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onPointerDown)
        document.addEventListener('keydown', onKeyDown)
        return () => {
            document.removeEventListener('mousedown', onPointerDown)
            document.removeEventListener('keydown', onKeyDown)
        }
    }, [open])

    const cancelFile = useCallback(async (id) => {
        setCancellingIds((prev) => new Set(prev).add(id))
        try {
            await cancelDownloadTasks({ taskIds: [id] })
        } catch (error) {
            console.error('Could not cancel download:', error)
        } finally {
            setCancellingIds((prev) => {
                const next = new Set(prev)
                next.delete(id)
                return next
            })
        }
    }, [])

    if (!visible) return null

    const muted = isLight ? 'text-gray-500' : 'text-gray-400'

    return (
        <>
            <button
                ref={buttonRef}
                type="button"
                data-tour-id="active-tasks-button"
                onMouseDown={(event) => event.stopPropagation()}
                onClick={() => setOpen((prev) => !prev)}
                aria-haspopup="menu"
                aria-expanded={open}
                title={`${total} active task${total === 1 ? '' : 's'}`}
                // The genome pills' own box (GenomePill): same type, padding and
                // border, so the button is exactly as tall as the pills beside it
                // and only as wide as its label.
                className={`flex-shrink-0 text-xs px-3 py-1.5 rounded-full border font-medium flex items-center gap-1.5 whitespace-nowrap transition-colors ${isLight
                    ? `border-blue-200 text-blue-700 ${open ? 'bg-blue-100' : 'bg-blue-50 hover:bg-blue-100'}`
                    : `border-blue-800/70 text-blue-200 ${open ? 'bg-blue-900/60' : 'bg-blue-900/30 hover:bg-blue-900/50'}`}`}
            >
                <ProgressRing progress={progress} size={12} />
                <span className="font-semibold">Active tasks</span>
                <span className="font-normal opacity-75 tabular-nums">{total}</span>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className={`flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true">
                    <polyline points="6 9 12 15 18 9" />
                </svg>
            </button>

            {open && menuPosition && typeof document !== 'undefined' ? createPortal(
                <div
                    ref={menuRef}
                    role="menu"
                    aria-label="Active tasks"
                    className={`fixed z-[1000] rounded-xl border shadow-xl overflow-hidden ${isLight ? 'bg-white border-gray-200' : 'bg-gray-800 border-gray-700'}`}
                    style={{ top: menuPosition.top, left: menuPosition.left, width: MENU_WIDTH }}
                >
                    <div className="max-h-[60vh] overflow-y-auto">
                        {sections.map((section) => (
                            <section key={section.id} className="px-3 pt-3 pb-2">
                                <h3 className={`text-[11px] font-bold uppercase tracking-wider mb-2 ${muted}`}>{section.title}</h3>
                                {section.active.length === 0 ? (
                                    <div className={`text-xs mb-1 ${muted}`}>Waiting to start…</div>
                                ) : (
                                    <ul className="space-y-2.5">
                                        {section.active.map((row) => {
                                            const percent = Math.round(row.progress * 100)
                                            return (
                                                <li key={row.id} className="grid grid-cols-[minmax(0,1fr)_20px] gap-x-2 items-start">
                                                    <div className="min-w-0">
                                                        {/* Species, assembly, accession. Each is held to a width so a
                                                            long name cannot push the others out; the full text is on hover. */}
                                                        <div className="flex items-baseline gap-1.5 min-w-0 text-xs">
                                                            <span
                                                                className={`min-w-0 max-w-[140px] truncate font-semibold ${isLight ? 'text-gray-900' : 'text-gray-100'}`}
                                                                title={[row.scientificName, row.genomeName !== row.scientificName ? row.genomeName : ''].filter(Boolean).join(' — ')}
                                                            >
                                                                {row.scientificName || row.genomeName}
                                                            </span>
                                                            {row.assemblyName && row.assemblyName !== row.accession ? (
                                                                <span className={`min-w-0 max-w-[100px] truncate ${isLight ? 'text-gray-700' : 'text-gray-300'}`} title={row.assemblyName}>
                                                                    {row.assemblyName}
                                                                </span>
                                                            ) : null}
                                                            <span className={`min-w-0 max-w-[130px] truncate font-mono text-[11px] ${muted}`} title={row.accession}>
                                                                {row.accession}
                                                            </span>
                                                        </div>
                                                        <div className="mt-1 flex items-center gap-2 text-[11px]">
                                                            <span className={`w-16 truncate ${isLight ? 'text-gray-700' : 'text-gray-300'}`}>{row.typeLabel}</span>
                                                            <div className={`flex-1 h-1.5 rounded-full overflow-hidden ${isLight ? 'bg-gray-200' : 'bg-gray-700'}`}>
                                                                <div
                                                                    className={`h-full rounded-full ${isLight ? 'bg-blue-600' : 'bg-blue-400'}`}
                                                                    style={{ width: `${Math.max(2, percent)}%`, transition: 'width 0.4s ease' }}
                                                                />
                                                            </div>
                                                            <span className={`w-8 text-right tabular-nums ${isLight ? 'text-blue-700' : 'text-blue-300'}`}>{percent}%</span>
                                                        </div>
                                                    </div>
                                                    <button
                                                        type="button"
                                                        onClick={() => cancelFile(row.id)}
                                                        disabled={cancellingIds.has(row.id)}
                                                        className={`mt-0.5 w-5 h-5 rounded flex items-center justify-center transition-colors disabled:opacity-40 ${isLight
                                                            ? 'text-gray-400 hover:text-red-700 hover:bg-red-50'
                                                            : 'text-gray-500 hover:text-red-300 hover:bg-red-900/30'}`}
                                                        title={`Cancel ${row.typeLabel} download`}
                                                        aria-label={`Cancel ${row.typeLabel} download for ${row.genomeName}`}
                                                    >
                                                        <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                                                            <line x1="2.4" y1="2.4" x2="7.6" y2="7.6" />
                                                            <line x1="7.6" y1="2.4" x2="2.4" y2="7.6" />
                                                        </svg>
                                                    </button>
                                                </li>
                                            )
                                        })}
                                    </ul>
                                )}
                                {section.queuedCount > 0 ? (
                                    <div className={`mt-3 text-[11px] font-bold uppercase tracking-wider ${muted}`}>
                                        {section.queuedCount} download{section.queuedCount === 1 ? '' : 's'} queued
                                    </div>
                                ) : null}
                            </section>
                        ))}
                    </div>
                    {onOpenDownloads ? (
                        <div className={`px-3 py-2 border-t ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
                            <button
                                type="button"
                                onClick={() => {
                                    setOpen(false)
                                    onOpenDownloads()
                                }}
                                className={`text-xs font-semibold ${isLight ? 'text-blue-700 hover:text-blue-900' : 'text-blue-300 hover:text-blue-100'}`}
                            >
                                Open Downloads →
                            </button>
                        </div>
                    ) : null}
                </div>,
                document.body,
            ) : null}
        </>
    )
}

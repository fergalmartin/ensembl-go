export function Chevron({ open, size = 14 }) {
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

export function HorizontalChevron({ pointsRight, size = 16 }) {
    return (
        <svg
            width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
        >
            <polyline points={pointsRight ? '9 6 15 12 9 18' : '15 6 9 12 15 18'} />
        </svg>
    )
}

export function TagGlyph({ size = 18 }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20.5 13.5 13.4 20.6a2 2 0 0 1-2.8 0L3.4 13.4a2 2 0 0 1-.6-1.4V5a2 2 0 0 1 2-2h7a2 2 0 0 1 1.4.6l7.3 7.1a2 2 0 0 1 0 2.8Z" />
            <circle cx="8" cy="8" r="1.35" fill="currentColor" stroke="none" />
        </svg>
    )
}

export function PanelModeGlyph({ mode, size = 16 }) {
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

export function PlusGlyph({ size = 18 }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
        </svg>
    )
}

export function DownloadGlyph({ size = 12 }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 3v12M7.5 10.5 12 15l4.5-4.5M5 20h14" />
        </svg>
    )
}

// One arrow, pointed out of the tray for an export and into it for an import.
export function TransferGlyph({ size = 14, direction = 'out' }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
            {direction === 'out'
                ? <path d="M12 15V3M12 3 8 7M12 3l4 4" />
                : <path d="M12 3v12M12 15l-4-4M12 15l4-4" />}
        </svg>
    )
}

export function TrashGlyph({ size = 18 }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 7h16M10 7V5h4v2M6 7l1 13h10l1-13" />
        </svg>
    )
}

export function ArchiveGlyph({ restore = false, size = 18 }) {
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

export function EditGlyph({ size = 18 }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 20h4l11-11a2.8 2.8 0 0 0-4-4L4 16v4z" />
            <path d="m13.5 6.5 4 4" />
        </svg>
    )
}

export function CompleteGlyph({ restore = false, size = 17 }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {restore
                ? <><path d="M8 7H4v-4" /><path d="M4.5 7.5A8 8 0 1 1 4 15" /></>
                : <path d="m4 12 5 5L20 6" />}
        </svg>
    )
}

export function DragGlyph({ size = 16 }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="9" cy="6" r="1.4" /><circle cx="15" cy="6" r="1.4" />
            <circle cx="9" cy="12" r="1.4" /><circle cx="15" cy="12" r="1.4" />
            <circle cx="9" cy="18" r="1.4" /><circle cx="15" cy="18" r="1.4" />
        </svg>
    )
}

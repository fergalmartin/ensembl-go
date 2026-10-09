export const IconChevron = ({ open, size = 14 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.15s ease' }} aria-hidden="true">
        <polyline points="6 9 12 15 18 9" />
    </svg>
)

export const AddGenomeGlyph = ({ size = 16, style = undefined, opacity = 1 }) => (
    <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        aria-hidden="true"
        style={style}
        opacity={opacity}
    >
        <path d="M12 5v14M5 12h14" />
    </svg>
)

export const IconClipboard = ({ size = 14 }) => (
    <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
    >
        <rect x="7" y="4" width="13" height="16" rx="2" />
        <path d="M16 4V3a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h2" />
    </svg>
)

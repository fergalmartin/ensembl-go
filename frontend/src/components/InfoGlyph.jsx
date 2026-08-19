// An "i" in a circle: the one mark in the browser that means "there is more to
// read about this here".
//
// Shared rather than inlined per component so the genome pill and the drawer's
// per-transcript control cannot drift apart — they are the same offer, and the
// reader learns it once.
export default function InfoGlyph({ size = 14, strokeWidth = 2 }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="11" x2="12" y2="16.5" />
            <line x1="12" y1="7.5" x2="12.01" y2="7.5" />
        </svg>
    )
}

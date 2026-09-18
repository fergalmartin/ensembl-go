// The small pieces of drawer chrome the genome browser's focus drawers share:
// the glyphs in their bands and section headings, and the buttons around them.
//
// Written out here so a drawer added later matches the two that already exist
// rather than approximating them.

import { DownloadMark, GenomeBrowserMark } from './appIconMarks'
import { LOCKED_ICON_PATH, UNLOCKED_ICON_PATH } from '../utils/lockIcons'
import { FOCUS_DRAWER_HEADER_BUTTON } from './focusDrawerStyle'

export function VerticalChevronGlyph({ pointsDown, size = 16 }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points={pointsDown ? '6 9 12 15 18 9' : '18 15 12 9 6 15'} />
        </svg>
    )
}

export function CopyGlyph({ size = 13 }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="5" y="5" width="14" height="16" rx="2.2" />
            <path d="M9 3h6v4H9z" />
        </svg>
    )
}

export function CloseGlyph({ size = 15 }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
        </svg>
    )
}

export function CogGlyph({ size = 15 }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
        </svg>
    )
}

/** The browser's own re-centre mark: "put this on screen". */
export function TargetGlyph({ size = 15 }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <circle cx="12" cy="12" r="6.5" />
            <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
            <path d="M12 1.5v3.5M12 19v3.5M1.5 12h3.5M19 12h3.5" />
        </svg>
    )
}

/** "Download this." The Download view's own mark, not an arrow drawn to look
 *  like it: a button that sends the reader to a view should wear that view's
 *  icon. Solid where its neighbours are stroked, so it is drawn a little
 *  smaller than they are to weigh the same. */
export function DownloadGlyph({ size = 15 }) {
    return <DownloadMark size={size} />
}

/** "Show this in the genome browser" — the browser's own mark, for the same
 *  reason. */
export function BrowserGlyph({ size = 17 }) {
    return <GenomeBrowserMark size={size} strokeWidth={1.9} />
}

/**
 * One of the small square buttons that sit in a band or a section heading.
 *
 * They are all the same size and all take the accent colour, which is what makes
 * a row of them read as a row rather than as several separate controls.
 */
/** The app's padlock: the same one the Feature Explorer locks a splice path
 *  with, and the genome browser its control bar. Shackle open until it is. */
export function LockGlyph({ locked = false, size = 14 }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d={locked ? LOCKED_ICON_PATH : UNLOCKED_ICON_PATH} />
        </svg>
    )
}

/** The browser's eye, struck through when what it controls is hidden. */
export function EyeGlyph({ hidden = false, size = 15 }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z" />
            <circle cx="12" cy="12" r="3" />
            {hidden && <path d="M3 3l18 18" />}
        </svg>
    )
}

// Grown along with the glyphs inside them: at 22x20 a 17px mark had a pixel of
// air on either side and the row read as cramped rather than as a set.
const COMPACT_DRAWER_BUTTON = { width: 24, height: 22 }

export function DrawerIconButton({ onClick, title, children, accent, rowHoverClass, expanded, compact = false }) {
    return (
        <button
            type="button"
            onClick={onClick}
            title={title}
            aria-label={title}
            aria-expanded={expanded}
            className={`flex-none flex items-center justify-center rounded transition-colors ${rowHoverClass}`}
            style={{ ...(compact ? COMPACT_DRAWER_BUTTON : FOCUS_DRAWER_HEADER_BUTTON), color: accent }}
        >
            {children}
        </button>
    )
}

/**
 * The heading above a list inside the drawer: a label, a rule, a count, and
 * somewhere for a control on the right.
 */
export function DrawerSectionHeading({ label, count, divider, subTextClass, children }) {
    return (
        <div className="flex items-center gap-2 px-2 pt-1 pb-0.5">
            <h3 className={`flex-none text-[11px] font-semibold tracking-wide uppercase ${subTextClass}`}>
                {label}
            </h3>
            <div className="flex-1 h-px" style={{ backgroundColor: divider }} />
            {count !== undefined && count !== null ? (
                <span className={`flex-none text-[11px] tabular-nums ${subTextClass}`}>({count})</span>
            ) : null}
            {children}
        </div>
    )
}

// The marks that stand for a whole view, drawn once.
//
// These two were being redrawn from memory wherever a button needed to say
// "download this" or "show this in the browser", and the copies had drifted:
// the focus drawer's browser was a window with a centre line, the navigation
// rail's was a window with three dots, and a reader moving between them had to
// work out that the two meant the same thing. Anything that points at the
// Download view or the genome browser draws it from here instead.

/** The Download view's mark. Solid, on a 32 grid, so it carries more weight at
 *  a given size than the stroked glyphs it usually sits beside. */
export function DownloadMark({ size = 16, style = undefined, opacity = 1 }) {
    return (
        <svg width={size} height={size} viewBox="0 0 32 32" fill="currentColor" stroke="none" aria-hidden="true" style={style}>
            <g opacity={opacity}>
                <path d="M3.5999999,2.7C3.5999999,2.8,3.5,2.9000001,3.5,3s0,0.2,0.0999999,0.3L15.5,19.5999985
	c0.1999998,0.2999992,0.6000004,0.2999992,0.7999992,0.2000008c0.1000004,0,0.1000004-0.1000004,0.2000008-0.2000008L28.3999996,3.3
	C28.6000004,3,28.5,2.6999998,28.1999989,2.5c-0.1000004-0.0999999-0.2000008-0.0999999-0.2999992-0.0999999H4.0999999
	C3.9000001,2.4000001,3.7,2.5,3.5999999,2.7z"/>
                <path d="M29.3353596,29.6499996c1,0,1.666666-0.833334,1.666666-1.6666679v-1.7666645c0-1-0.833334-1.666666-1.666666-1.666666
	H2.6686926c-0.8333333,0-1.6666666,0.666666-1.6666666,1.666666v1.7666645c0,0.833334,0.6666669,1.6666679,1.6666666,1.6666679
	H29.3353596z"/>
            </g>
        </svg>
    )
}

/** The genome browser's mark: the browser window, with the three dots of its
 *  title bar. */
export function GenomeBrowserMark({ size = 16, strokeWidth = 2 }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="2" y="3" width="20" height="18" rx="2" />
            <line x1="2" y1="9" x2="22" y2="9" />
            <circle cx="5.5" cy="6" r="0.8" fill="currentColor" stroke="none" />
            <circle cx="8.5" cy="6" r="0.8" fill="currentColor" stroke="none" />
            <circle cx="11.5" cy="6" r="0.8" fill="currentColor" stroke="none" />
        </svg>
    )
}

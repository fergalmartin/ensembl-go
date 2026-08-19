import { noteBubbleGlyphPaths } from '../utils/noteBubbleGlyph'

// A speech bubble: the one mark in the browser that means "someone wrote
// something about this".
//
// Shared rather than inlined per component so the drawer's notes section and
// the bubble the canvas draws over an annotated gene cannot drift apart — they
// are the same offer, and the reader learns it once. Its geometry comes from
// `noteBubbleGlyph.js`, which the canvas and the SVG export read too.
//
// `filled` is how a mark says there is something here rather than somewhere to
// put something: an outline for an empty notes section, a solid bubble once the
// gene actually has notes.
export default function NoteGlyph({ size = 14, filled = false, knockout = 'transparent' }) {
    const paths = noteBubbleGlyphPaths(size)
    if (!paths) return null
    return (
        <svg
            width={size}
            height={size}
            viewBox={`0 0 ${size} ${size}`}
            fill="none"
            stroke="currentColor"
            strokeWidth={paths.stroke}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d={paths.body} fill={filled ? 'currentColor' : 'none'} />
            {paths.lines.map((line) => (
                // Knocked out of a filled bubble, so the rules read as writing on
                // it rather than as ink over ink.
                <path key={line} d={line} stroke={filled ? knockout : 'currentColor'} />
            ))}
        </svg>
    )
}

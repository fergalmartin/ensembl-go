import { FONT_MONO } from '../../utils/typography'
import { DEFAULT_PALETTE } from '../../utils/sequenceViewColours'
import { groupDigits } from '../../utils/sequenceViewDisplay'

/**
 * One floating readout, following the pointer.
 *
 * One, rather than a title on every base cell: at sixty cells a row and forty
 * rows on screen that would be thousands of attributes and thousands of
 * handlers, for something only ever true of one cell at a time. It is also how
 * the exact coordinate of an individual base is read, which the numbers in the
 * gutters cannot give.
 */
export default function SequenceHoverTip({ hover, isLight, chrom, palette = DEFAULT_PALETTE }) {
    if (!hover) return null
    const style = hover.code ? palette.style(hover.code) : null
    const panel = isLight
        ? 'bg-white border-gray-200 text-gray-700 shadow-lg'
        : 'bg-gray-900 border-gray-700 text-gray-200 shadow-xl'

    return (
        <div
            className={`pointer-events-none fixed z-50 flex items-center gap-2 rounded border px-2 py-1 text-xs ${panel}`}
            style={{ left: hover.x + 14, top: hover.y + 14, fontFamily: FONT_MONO }}
        >
            {hover.gap ? (
                // There is no base under a marker, but there is still an answer:
                // how much is missing, and where it picks up again.
                <>
                    <span><span className="font-semibold">{groupDigits(hover.gap.hidden)} bp</span> not shown</span>
                    <span className="tabular-nums">
                        {chrom}:{hover.gap.s.toLocaleString()}&ndash;{hover.gap.e.toLocaleString()}
                    </span>
                </>
            ) : (
                <>
                    <span className="tabular-nums">
                        {chrom}:{Number(hover.coord).toLocaleString()}
                    </span>
                    <span className="font-semibold">{hover.base}</span>
                </>
            )}
            {style && !hover.gap ? (
                // A swatch and its word are one fact, so they sit tight together
                // while the facts themselves are spaced apart.
                <span className="flex items-center gap-1">
                    <span
                        className="inline-block h-2 w-2 rounded-sm"
                        style={{
                            backgroundColor: style.outline ? 'transparent' : style.bg,
                            border: `1px solid ${style.bg}`,
                        }}
                    />
                    {style.label}
                </span>
            ) : null}
            {hover.genes > 1 && !hover.gap ? (
                // What the rule under the base means, in words. The class above
                // says what the sequence is; this says how many genes say it.
                <span className="flex items-center gap-1">
                    <span
                        className="inline-block h-2 w-2"
                        style={{ borderBottom: `2px solid ${palette.overlap}` }}
                    />
                    {hover.genes} genes
                </span>
            ) : null}
        </div>
    )
}

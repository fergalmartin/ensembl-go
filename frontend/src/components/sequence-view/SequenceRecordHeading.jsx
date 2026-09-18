import { memo } from 'react'

import { FONT_MONO } from '../../utils/typography'
import { formatDistance } from '../../utils/sequenceViewDistance'
import { strandText } from '../../utils/sequenceViewLabels'

/**
 * A record's name, above its sequence.
 *
 * One row tall, like everything else in the document: the scroller maps a scroll
 * position to a row by multiplying, and a heading that were a different height
 * would put a second case into the one piece of arithmetic the whole view rests
 * on. So it is a row that happens to hold a name rather than sixty bases.
 */
function SequenceRecordHeading({ record, layout, rowHeight, width, isLight }) {
    if (!record) return null
    const rule = isLight ? '#e5e7eb' : '#374151'
    const name = isLight ? 'text-gray-800' : 'text-gray-100'
    const quiet = isLight ? 'text-gray-500' : 'text-gray-400'
    const span = Math.abs(record.end - record.start) + 1
    const region = layout?.region

    return (
        <div
            className="flex items-center gap-2 overflow-hidden border-t px-1"
            style={{
                height: `${rowHeight}px`,
                width: `${width}px`,
                borderColor: rule,
                fontFamily: FONT_MONO,
            }}
            data-record-heading={record.key}
        >
            <span className={`flex-none text-[13px] font-semibold ${name}`}>{record.label}</span>
            {record.detail ? (
                <span className={`flex-none text-[11px] ${quiet}`}>{record.detail}</span>
            ) : null}
            <span className={`flex-none text-[11px] tabular-nums ${quiet}`}>
                {record.chrom}:{Number(region?.start ?? record.start).toLocaleString()}
                &ndash;{Number(region?.end ?? record.end).toLocaleString()}
            </span>
            <span className={`flex-none text-[11px] ${quiet}`}>{strandText(record.strand)}</span>
            <span className={`flex-none text-[11px] ${quiet}`}>{formatDistance(span)}</span>
            {/* What was left out, where anything was: the heading is the only
                place a collapsed record can say so, since the bar above
                describes the collection rather than any one of them. */}
            {layout?.hidden ? (
                <span className={`flex-none text-[11px] ${quiet}`}>
                    &minus;{formatDistance(layout.hidden)} hidden
                </span>
            ) : null}
        </div>
    )
}

export default memo(SequenceRecordHeading)

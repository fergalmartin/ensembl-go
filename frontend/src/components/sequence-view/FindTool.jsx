import { ControlChevron, ControlLabel } from './ControlChrome'
import { matchLabel, shortPattern } from '../../utils/findPatterns'

/**
 * Looking for something, on the bar.
 *
 * The same split the Select tool is -- a face and a chevron -- and for the same
 * reason: there are two things a reader might want and only one of them is what
 * they usually want. The face opens the box; the chevron opens the box with
 * everything else in it.
 *
 * What it does *not* do is open a menu. Everything else on this bar hangs a
 * panel off its button, which is right for a setting: it is read, changed and
 * dismissed. A find box is not dismissed. The reader types in it, looks at the
 * sequence, steps to the next match, looks again -- so it is a band under the
 * bar that stays until it is closed, the way every find box in every
 * application is. See FindBar.jsx for the band itself.
 */
export default function FindTool({
    open = '',
    // What the box holds, which is what the reader is looking for -- either
    // something to match or the notation naming their saved patterns.
    query = '',
    matches = null,
    disabled = false,
    disabledReason = '',
    onOpen,
}) {
    const first = String(query || '').trim()

    // What the bar says when the band is shut, which is the whole reason the
    // band can be shut: the count is the answer, and a reader who has found
    // what they were looking for should not have to keep a box open to see it.
    //
    // The pattern is shown short. It can be five hundred characters, and a
    // control that grew to hold one would shuffle every control after it along
    // on each keystroke -- see `shortPattern`. The width is pinned in the
    // stylesheet as well, because a count of four million is wide too.
    const value = matches?.pending
        ? 'Searching…'
        : !first ? 'Off'
            : matches?.searching && matches.total > 0
                ? matchLabel(matches.at, matches.total, { truncated: matches.truncated })
                : matches?.searching ? 'No matches'
                    : shortPattern(first)

    return (
        <div className={`sv-split sv-split-find ${open ? 'selected' : ''}`} data-sequence-find="true">
            <button
                type="button"
                className="sv-split-main"
                data-sequence-find-open="true"
                aria-pressed={Boolean(open)}
                disabled={disabled}
                onClick={() => onOpen?.(open ? '' : 'simple')}
                title={disabled ? disabledReason
                    : first ? `Looking for ${first}. Press to ${open ? 'close' : 'open'} the find box.`
                        : 'Find a string or a pattern in this region'}
            >
                <ControlLabel label="Find" value={value} active={Boolean(first && open)} />
            </button>
            <button
                type="button"
                className="sv-split-arrow"
                data-sequence-find-more="true"
                aria-expanded={open === 'full'}
                disabled={disabled}
                onClick={() => onOpen?.(open === 'full' ? '' : 'full')}
                title={disabled ? disabledReason
                    : 'Find several things at once, in colours of your own and in an order of your own'}
                aria-label="More find options"
            >
                <ControlChevron />
            </button>
        </div>
    )
}

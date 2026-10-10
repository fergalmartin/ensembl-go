import ControlLabel from './ControlLabel'
import ControlChevron from './ControlChevron'
import { shortPattern } from '../../utils/findPatterns'

/**
 * Open the shared FindBar below the toolbar.
 * The face opens the search box; the chevron opens the saved-pattern list.
 * Keep the box open until dismissed so matches can be inspected and stepped.
 */
export default function FindTool({ open = '', query = '', matches = null, disabled = false, onOpen }) {
  const first = String(query || '').trim()
  // What the bar says. While the box is open it is the answer - which block of
  // how many - and shut it is what the box holds, short: a five-hundred
  // character expression would otherwise push every control after it along.
  const value = matches?.pending ? 'Preparing…'
    : !first ? 'Off'
      : matches?.searching && matches.total > 0 ? matches.label
        : matches?.searching ? 'No matches'
          : shortPattern(first)
  return <div className={`al-split al-control-find ${open ? 'selected' : ''}`} data-alignment-find="true">
    <button type="button" className="al-split-main" aria-pressed={Boolean(open)} disabled={disabled}
      title={first ? `Search: ${first}. Click to ${open ? 'close' : 'open'} the find box.` : 'Find a sequence or pattern in this alignment (Ctrl-F)'}
      onClick={() => onOpen?.(open ? '' : 'simple')}>
      <ControlLabel label="Find" value={value} active={Boolean(first && open)}/>
    </button>
    <button type="button" className="al-split-arrow" aria-expanded={open === 'full'} disabled={disabled}
      aria-label="More find options" title="Search for multiple patterns with custom colours and priorities"
      onClick={() => onOpen?.(open === 'full' ? '' : 'full')}>
      <ControlChevron/>
    </button>
  </div>
}

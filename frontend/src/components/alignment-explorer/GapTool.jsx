import { useCallback, useId, useRef, useState } from 'react'
import ControlLabel from './ControlLabel'
import ControlChevron from './ControlChevron'
import ControlMenu from './ControlMenu'
import { menuPosition, useMenuDismiss } from './menuAnchor'
import { GAP_MIN_SHARE, gapDirty, gapHidesBases, gapMinimum, gapRowsNeeded, gapShare, gapSliderFill, gapValue } from './gapSettings'

/** Closing up the columns nobody on screen has a base in.
 *
 * Its own control, and not a section of Hide, because it answers to something
 * different. Hide is about the reader's picks: it takes away what is not among
 * them, and until something is picked there is nothing for it to do. This is
 * about the sheet as it stands - every sequence being drawn, however that set
 * came about, whether the whole alignment or what a filter or a hide has left -
 * and it is always something it can do. Sharing one menu meant sharing one
 * Apply, and that Apply could only be gated on one of the two: the gap settings
 * ended up needing a selection that has nothing to do with them, and pressing
 * Apply without one did nothing at all.
 *
 * The face is still the quick switch, the way Pan's and Select's are, so turning
 * gaps off and on again is one press. But the menu asks the whole question too:
 * show them or hide them, and, if hidden, how. A menu that only held the "how"
 * left a reader who had opened it to turn the thing off with no way to do it
 * from where they were standing - the only way back was a button they had no
 * reason to read as a switch - and it gated Apply on settings they had not come
 * to change. The choice is part of the draft, so Apply lights up for it like any
 * other change and publishes both halves at once.
 */
export default function GapTool({ closed, marks, min, percent, rows = 0, status, root, onToggle, onApply, onStop, onRetry, disabled }) {
  const [anchor, setAnchor] = useState(null), [draft, setDraft] = useState(null)
  const button = useRef(null), menuId = useId()
  const close = useCallback(() => { setAnchor(null); setDraft(null) }, [])
  useMenuDismiss(!!anchor, close, button, 'al-tool-menu')
  const open = () => {
    if (anchor) { close(); return }
    setDraft({ closed, marks, min: String(min), percent })
    setAnchor(menuPosition(button.current, 320))
  }
  const value = gapValue(closed, status)
  const typed = gapMinimum(draft?.min)
  const share = gapShare(draft?.percent)
  const hiding = !!draft?.closed
  const dirty = gapDirty(draft, { closed, marks, min, percent })
  const needed = gapRowsNeeded(rows, share)
  const counted = status.done + status.failed
  return <>
    <div ref={button} className={`al-split al-control-gaps ${closed ? 'selected' : ''} ${anchor ? 'menu-open' : ''}`}>
      <button className="al-split-main" disabled={disabled} aria-pressed={closed}
        title={closed
          ? `${gapHidesBases(percent) ? `Columns with gaps in at least ${percent}% of visible sequences are` : 'Gap-only columns are'} hidden. Click to show them again.`
          : 'Hide columns that meet the current gap settings.'}
        onClick={() => onToggle(!closed)}><ControlLabel label="Gaps" value={value}/></button>
      <button className="al-split-arrow" disabled={disabled} aria-label="Gap options"
        aria-haspopup="dialog" aria-expanded={!!anchor} aria-controls={anchor ? menuId : undefined}
        title="Choose which gap columns to hide" onClick={open}><ControlChevron/></button>
    </div>
    {draft && <ControlMenu id={menuId} root={root} anchor={anchor} title="Gaps" current={value} className="al-gap-menu">
      <small>Hide columns with gaps in all or most visible sequences. Hidden columns are recalculated whenever the visible sequences change.</small>
      <div className="al-menu-options">
        <button type="button" className={`al-menu-option ${hiding ? '' : 'selected'}`} aria-pressed={!hiding}
          onClick={() => setDraft(v => ({ ...v, closed: false }))}>
          <strong>Show all columns</strong><small>Display every alignment column, including columns containing only gaps.</small></button>
        <button type="button" className={`al-menu-option ${hiding ? 'selected' : ''}`} aria-pressed={hiding}
          onClick={() => setDraft(v => ({ ...v, closed: true }))}>
          <strong>Hide gap columns</strong><small>Hide runs of columns that meet the gap threshold below. Hidden columns remain part of selections and exports.</small></button>
      </div>
      <fieldset className="al-collapse-settings al-gap-settings" disabled={!hiding} aria-label="Gap threshold and display settings">
        <span className="al-gap-settings-title">Gap threshold</span>
        <label className="al-gap-share">
          <span>Gaps in at least <strong>{share}%</strong> of visible sequences{rows ? <small>{share === 100 ? ` · all ${rows} visible` : ` · ${needed} of the ${rows} visible`}</small> : null}</span>
          <input type="range" min={GAP_MIN_SHARE} max="100" step="5" value={share}
            aria-label="Minimum percentage of visible sequences with a gap"
            aria-valuetext={`${share} per cent`}
            style={{ '--al-fill': `${gapSliderFill(share)}%` }}
            onChange={e => setDraft(v => ({ ...v, percent: Number(e.target.value) }))}/>
        </label>
        <small>{gapHidesBases(share)
          ? 'Below 100%, hidden columns may contain bases. The threshold is calculated separately for the visible sequences in each block.'
          : 'At 100%, only columns with gaps in every visible sequence are hidden. No bases are hidden.'}</small>
        <span className="al-gap-settings-title">Display settings</span>
        <label className="al-menu-check"><input type="checkbox" checked={draft.marks}
          onChange={e => setDraft(v => ({ ...v, marks: e.target.checked }))}/>Show gap boundaries</label>
        <label>Minimum run length<input type="text" inputMode="numeric" size="4" maxLength="6"
          aria-label="Minimum number of consecutive columns to hide" value={draft.min}
          onChange={e => setDraft(v => ({ ...v, min: e.target.value.replace(/[^0-9]/g, '') }))}/></label>
        <small>{draft.marks
          ? 'A thin line marks each hidden run. Increase the minimum run length to keep shorter gaps visible.'
          : 'Hidden runs have no boundary marks, so the sequences on either side appear continuous. Block headers show the hidden column count, and the ruler keeps the original column numbers.'}</small>
      </fieldset>
      <small>{!closed ? 'All columns are currently shown. Choose Hide gap columns and click Apply to hide runs that meet these settings.'
        : status.pending ? `Checking columns against the gap threshold — ${counted} of ${status.total} ${status.total === 1 ? 'block' : 'blocks'} checked.`
        : status.unavailable ? 'Gap hiding is unavailable in the block overview. Zoom in to individual blocks to apply it automatically.'
        : status.failed ? `${status.failed} of ${status.total} ${status.failed === 1 ? 'block' : 'blocks'} could not be checked, and ${status.failed === 1 ? 'that block is' : 'those blocks are'} shown in full.`
        : status.skipped ? 'This view exceeds the gap check limit of 500 sequences or 60 million alignment cells. Filter or hide some sequences, or open a single block.'
        : status.columns ? `${status.columns.toLocaleString()} ${status.columns === 1 ? 'column is' : 'columns are'} hidden${gapHidesBases(percent) ? ` (gaps in at least ${percent}% of visible sequences per block)` : ''}${status.truncated ? '; some short runs remain visible because the result reached the processing limit' : ''}. Hidden columns remain part of selections and exports.`
        : gapHidesBases(percent) ? `No runs meet the ${percent}% gap threshold and minimum length. Lower the threshold or minimum run length, or hide sequences that contain bases in those columns.`
        : 'No runs meet the current settings. Columns with even one base stay visible at 100%. Lower the threshold or minimum run length, or hide sequences that contain bases in the gaps.'}</small>
      {!!status.failed && !status.pending && <button onClick={onRetry}>Retry failed blocks</button>}
      {status.slow && <div className="al-collapse-progress" role="status" aria-live="polite">
        <div className="al-progress-track"><div className="al-progress-fill" style={{ width: `${Math.round(100 * counted / Math.max(1, status.total))}%` }}/></div>
        <div className="al-progress-foot"><small>{counted} of {status.total} {status.total === 1 ? 'block' : 'blocks'} checked</small>
          <button onClick={onStop}>Stop</button></div>
      </div>}
      <small>Click Apply to save these settings.</small>
      <div className="al-menu-actions"><button onClick={close}>Cancel</button>
        <button className="primary" disabled={!dirty}
          onClick={() => { onApply({ closed: hiding, marks: draft.marks, min: typed, percent: share }); close() }}>Apply</button></div>
    </ControlMenu>}
  </>
}

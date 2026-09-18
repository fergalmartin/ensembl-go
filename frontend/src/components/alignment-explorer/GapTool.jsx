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
          ? `${gapHidesBases(percent) ? `Columns ${percent}% of the sequences are a gap in are` : 'Gap-only columns are'} hidden. Click to show them again.`
          : 'Hide the columns no sequence on screen has a base in.'}
        onClick={() => onToggle(!closed)}><ControlLabel label="Gaps" value={value}/></button>
      <button className="al-split-arrow" disabled={disabled} aria-label="Gap options"
        aria-haspopup="dialog" aria-expanded={!!anchor} aria-controls={anchor ? menuId : undefined}
        title="Show or hide gappy columns" onClick={open}><ControlChevron/></button>
    </div>
    {draft && <ControlMenu id={menuId} root={root} anchor={anchor} title="Gaps" current={value} className="al-gap-menu">
      <small>A column every sequence on screen is a gap in says nothing to a reader looking at them, and a column nearly all of them are a gap in says little more. Hiding them is worked out again whenever that set of sequences changes, so showing a sequence again puts back whatever it fills.</small>
      <div className="al-menu-options">
        <button type="button" className={`al-menu-option ${hiding ? '' : 'selected'}`} aria-pressed={!hiding}
          onClick={() => setDraft(v => ({ ...v, closed: false }))}>
          <strong>Show gap-only columns</strong><small>Every column of every block is drawn, in its own place.</small></button>
        <button type="button" className={`al-menu-option ${hiding ? 'selected' : ''}`} aria-pressed={hiding}
          onClick={() => setDraft(v => ({ ...v, closed: true }))}>
          <strong>Hide gappy columns</strong><small>Close up the runs enough of the sequences on screen are a gap in. They stay in the alignment, selectable and exported.</small></button>
      </div>
      <fieldset className="al-collapse-settings al-gap-settings" disabled={!hiding} aria-label="Which columns are hidden, and how">
        <span className="al-gap-settings-title">Which columns</span>
        <label className="al-gap-share">
          <span>Gap in at least <strong>{share}%</strong> of the sequences{rows ? <small>{share === 100 ? ` · all ${rows} on screen` : ` · ${needed} of the ${rows} on screen`}</small> : null}</span>
          <input type="range" min={GAP_MIN_SHARE} max="100" step="5" value={share}
            aria-label="Share of the sequences that must be a gap"
            aria-valuetext={`${share} per cent`}
            style={{ '--al-fill': `${gapSliderFill(share)}%` }}
            onChange={e => setDraft(v => ({ ...v, percent: Number(e.target.value) }))}/>
        </label>
        <small>{gapHidesBases(share)
          ? 'Below 100% a hidden column still holds bases, and those bases stop being drawn. The share is of the sequences each block holds, so a block carrying fewer of them needs fewer.'
          : 'At 100% a hidden column holds no sequence at all: every sequence on screen is a gap there, so nothing stops being drawn that was ever drawn.'}</small>
        <span className="al-gap-settings-title">How they are hidden</span>
        <label className="al-menu-check"><input type="checkbox" checked={draft.marks}
          onChange={e => setDraft(v => ({ ...v, marks: e.target.checked }))}/>Show gap boundaries</label>
        <label>Shortest run<input type="text" inputMode="numeric" size="4" maxLength="6"
          aria-label="Shortest run of columns to hide" value={draft.min}
          onChange={e => setDraft(v => ({ ...v, min: e.target.value.replace(/[^0-9]/g, '') }))}/></label>
        <small>{draft.marks
          ? 'A hairline stands where each hidden stretch was. Raise the shortest run to leave short gaps, and their marks, alone.'
          : 'No marks: the sequence either side of a hidden stretch is drawn as one continuous run. The header still counts what is not being drawn, and the ruler still numbers every column by its real position.'}</small>
      </fieldset>
      <small>{!closed ? 'Gap-only columns are shown at the moment. Choose Hide and press Apply to close them up.'
        : status.pending ? `Working out which columns are empty — ${counted} of ${status.total} ${status.total === 1 ? 'block' : 'blocks'} checked.`
        : status.unavailable ? 'Each panel on screen stands for a run of blocks rather than for their columns, so there is nothing here to work out yet. Zoom in until single blocks are drawn and their empty columns close up on their own.'
        : status.failed ? `${status.failed} of ${status.total} ${status.failed === 1 ? 'block' : 'blocks'} could not be checked, and ${status.failed === 1 ? 'that block is' : 'those blocks are'} drawn whole.`
        : status.skipped ? 'This sheet is too large to check - more than 500 sequences, or more than 60 million cells of alignment on screen. Filter or hide some sequences, or open a single block.'
        : status.columns ? `${status.columns.toLocaleString()} ${status.columns === 1 ? 'column is' : 'columns are'} hidden${gapHidesBases(percent) ? `, at ${percent}% or more of each block's sequences` : ''}${status.truncated ? ', and some short runs were left in to keep the answer bounded' : ''}. Every one of them is still in the alignment, still selectable and still exported.`
        : gapHidesBases(percent) ? `Nothing here is a gap in ${percent}% of the sequences a block holds. Lower the share, or hide the sequences filling those columns, and stretches begin to close.`
        : 'Nothing is closable: every column here has a base in at least one of the sequences on screen. A stretch that looks empty usually still has one sequence running through it - often a reconstructed ancestor - and one base is enough to keep the column. Lower the share below 100%, or hide those sequences, and the stretch becomes closable.'}</small>
      {!!status.failed && !status.pending && <button onClick={onRetry}>Check those blocks again</button>}
      {status.slow && <div className="al-collapse-progress" role="status" aria-live="polite">
        <div className="al-progress-track"><div className="al-progress-fill" style={{ width: `${Math.round(100 * counted / Math.max(1, status.total))}%` }}/></div>
        <div className="al-progress-foot"><small>{counted} of {status.total} {status.total === 1 ? 'block' : 'blocks'} checked</small>
          <button onClick={onStop}>Stop</button></div>
      </div>}
      <small>Changes take effect with Apply.</small>
      <div className="al-menu-actions"><button onClick={close}>Cancel</button>
        <button className="primary" disabled={!dirty}
          onClick={() => { onApply({ closed: hiding, marks: draft.marks, min: typed, percent: share }); close() }}>Apply</button></div>
    </ControlMenu>}
  </>
}

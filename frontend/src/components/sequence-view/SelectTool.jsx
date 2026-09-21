import { useCallback, useId, useRef, useState } from 'react'

import { menuPosition, useMenuDismiss } from '../alignment-explorer/menuAnchor'
import { ControlChevron, ControlLabel, ControlMenu } from './ControlChrome'
import { SELECT_MODES, selectModeLabel } from '../../utils/sequenceViewSelect'

/**
 * Turning selection on, and choosing how it is drawn.
 *
 * The bar's split control: the face turns the tool on and off, the arrow beside
 * it says how. It was a square glyph with no words on it, which said that
 * something could be turned on but not what, and had nowhere to put a second way
 * of doing it.
 *
 * The face carries the same two lines Display does -- the name, and under it
 * what the tool is set to -- because they are the same kind of control and a
 * reader should not have to open a menu to find out which of the two ways is in
 * hand. Whether it is *on* is a different fact from which way it selects, so it
 * is said beside the name rather than under it.
 *
 * Two ways, because they fail differently. A drag is quicker and is what every
 * other view in the app draws a rectangle with -- but a drag across a thousand
 * bases means holding the button while the page scrolls under you, and letting
 * go early is a selection you have to start again. Clicking the two ends has no
 * such moment: the reader can scroll as far as it takes between the clicks.
 */
export default function SelectTool({
    armed,
    mode,
    root,
    // Where the gesture belongs to something else. The plain displays hand it
    // to the browser, and a tool that drew a second kind of selection over a
    // text highlight would put two shapes on the screen at once. The face says
    // so in the line that otherwise reports the mode, since a control greyed out
    // with no word for why is a control that looks broken.
    disabled = false,
    disabledReason = '',
    onArm,
    onMode,
}) {
    const [anchor, setAnchor] = useState(null)
    const button = useRef(null)
    const menuId = useId()
    const close = useCallback(() => setAnchor(null), [])
    useMenuDismiss(Boolean(anchor), close, button, 'sv-menu')

    const open = () => {
        if (anchor) close()
        else setAnchor(menuPosition(button.current, 300, 'sv'))
    }

    // Picking a way of selecting turns the tool on as well. A reader opening this
    // menu is not idly comparing the two: they are about to select something.
    const choose = (id) => {
        onMode(id)
        onArm(true)
        close()
    }

    return (
        <>
            <div className={`sv-split ${armed && !disabled ? 'selected' : ''}`} data-sequence-select="true">
                <button
                    ref={button}
                    type="button"
                    className="sv-split-main"
                    data-sequence-select-arm="true"
                    aria-pressed={armed}
                    disabled={disabled}
                    onClick={() => onArm(!armed)}
                    title={disabled ? disabledReason : armed
                        ? `Selecting by ${selectModeLabel(mode).toLowerCase()}. Press to turn it off.`
                        : `Press to select a stretch of sequence by ${selectModeLabel(mode).toLowerCase()}.`}
                >
                    <ControlLabel
                        label="Select"
                        value={disabled ? 'Inactive' : selectModeLabel(mode)}
                        active={armed && !disabled}
                    />
                </button>
                <button
                    type="button"
                    className="sv-split-arrow"
                    data-sequence-select-mode="true"
                    disabled={disabled}
                    aria-haspopup="dialog"
                    aria-expanded={Boolean(anchor)}
                    aria-controls={anchor ? menuId : undefined}
                    onClick={open}
                    title={disabled ? disabledReason : 'Choose how to select'}
                    aria-label="Choose how to select"
                >
                    <ControlChevron />
                </button>
            </div>
            <ControlMenu id={menuId} root={root} anchor={anchor} title="Select">
                <div className="sv-menu-options">
                    {SELECT_MODES.map((option) => (
                        <button
                            key={option.id}
                            type="button"
                            className={`sv-menu-option ${option.id === mode ? 'selected' : ''}`}
                            aria-pressed={option.id === mode}
                            onClick={() => choose(option.id)}
                        >
                            <strong>{option.label}</strong>
                            <small>{option.hint}</small>
                        </button>
                    ))}
                </div>
                <div className="sv-menu-actions">
                    <small>Choosing one turns the tool on.</small>
                    <button type="button" onClick={close}>Close</button>
                </div>
            </ControlMenu>
        </>
    )
}

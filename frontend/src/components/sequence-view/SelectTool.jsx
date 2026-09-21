import { useCallback, useId, useRef, useState } from 'react'

import { menuPosition, useMenuDismiss } from '../alignment-explorer/menuAnchor'
import { ControlChevron, ControlMenu } from './ControlChrome'
import { SELECT_MODES, selectModeLabel } from '../../utils/sequenceViewSelect'

/**
 * Arming a selection, and choosing how it is drawn.
 *
 * The bar's split control: the face turns the tool on and off, the arrow beside
 * it says how. It was a square glyph with no words on it, which said that
 * something could be armed but not what, and had nowhere to put a second way of
 * doing it.
 *
 * Two ways, because they fail differently. A drag is quicker and is what every
 * other view in the app arms a rectangle with -- but a drag across a thousand
 * bases means holding the button while the page scrolls under you, and letting
 * go early is a selection you have to start again. Clicking the two ends has no
 * such moment: the page is yours between the clicks, to scroll as far as it
 * takes.
 */
export default function SelectTool({ armed, mode, root, onArm, onMode }) {
    const [anchor, setAnchor] = useState(null)
    const button = useRef(null)
    const menuId = useId()
    const close = useCallback(() => setAnchor(null), [])
    useMenuDismiss(Boolean(anchor), close, button, 'sv-menu')

    const open = () => {
        if (anchor) close()
        else setAnchor(menuPosition(button.current, 300, 'sv'))
    }

    // Picking a way of selecting arms the tool as well. A reader opening this
    // menu is not idly comparing the two: they are about to select something.
    const choose = (id) => {
        onMode(id)
        onArm(true)
        close()
    }

    return (
        <>
            <div className={`sv-split ${armed ? 'selected' : ''}`} data-sequence-select="true">
                <button
                    ref={button}
                    type="button"
                    className="sv-split-main"
                    data-sequence-select-arm="true"
                    aria-pressed={armed}
                    onClick={() => onArm(!armed)}
                    title={armed
                        ? `Selecting by ${selectModeLabel(mode).toLowerCase()}. Press to put the tool down.`
                        : 'Select a stretch of sequence'}
                >
                    {/* The word alone. Which of the two ways it is set to is
                        behind the arrow, where it was chosen: the face is a
                        switch, and a switch that also reported a setting read
                        as though pressing it would change that setting. */}
                    <span className="sv-control-name">Select</span>
                </button>
                <button
                    type="button"
                    className="sv-split-arrow"
                    data-sequence-select-mode="true"
                    aria-haspopup="dialog"
                    aria-expanded={Boolean(anchor)}
                    aria-controls={anchor ? menuId : undefined}
                    onClick={open}
                    title="Choose how to select"
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
                    <small>Picking one arms the tool.</small>
                    <button type="button" onClick={close}>Close</button>
                </div>
            </ControlMenu>
        </>
    )
}

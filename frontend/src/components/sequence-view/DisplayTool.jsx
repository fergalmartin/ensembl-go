import { useCallback, useId, useRef, useState } from 'react'

import { menuPosition, useMenuDismiss } from '../alignment-explorer/menuAnchor'
import { ControlChevron, ControlLabel, ControlMenu } from './ControlChrome'
import {
    DISPLAY_MODES,
    DISPLAY_RICH,
    displayMode,
    isPlainDisplay,
} from '../../utils/sequenceViewPlain'

/**
 * How the sequence is drawn: as a view, or as text.
 *
 * The other controls on this bar all change *what* is on the screen -- where to
 * look, what to colour, what to leave out. This one changes what the screen
 * *is*, which is why it is a control of its own and not a switch inside the
 * feature menu: a reader who wants to copy a stretch of sequence with `Ctrl-C`
 * is not looking for a setting about features.
 *
 * The colour switch lives here rather than in the Colour menu because it is
 * about this display rather than about the palette: it says whether the plain
 * displays print their letters in the classes' colours, and it means nothing at
 * all while the interactive display is on. Which classes those colours are for
 * is still the Colour menu's question, and this changes none of them.
 */
export default function DisplayTool({
    display = DISPLAY_RICH,
    colour = true,
    disabled = false,
    disabledReason = '',
    root,
    onDisplay,
    onColour,
}) {
    const [anchor, setAnchor] = useState(null)
    const button = useRef(null)
    const menuId = useId()
    const close = useCallback(() => setAnchor(null), [])
    useMenuDismiss(Boolean(anchor), close, button, 'sv-menu')

    const current = displayMode(display)
    const plain = isPlainDisplay(display)

    const open = () => {
        if (anchor) close()
        else setAnchor(menuPosition(button.current, 320, 'sv'))
    }

    const choose = (id) => {
        close()
        if (id !== display) onDisplay?.(id)
    }

    return (
        <>
            <button
                ref={button}
                type="button"
                className={`sv-control sv-control-display ${anchor ? 'menu-open' : ''}`}
                data-sequence-display="true"
                aria-haspopup="dialog"
                aria-expanded={Boolean(anchor)}
                aria-controls={anchor ? menuId : undefined}
                disabled={disabled}
                onClick={open}
                title={disabled ? disabledReason : current.hint}
            >
                <ControlLabel label="Display" value={current.short} />
                <ControlChevron />
            </button>

            <ControlMenu id={menuId} root={root} anchor={anchor} title="Display">
                <div className="sv-menu-options" role="radiogroup" aria-label="Display">
                    {DISPLAY_MODES.map((option) => (
                        <button
                            key={option.id}
                            type="button"
                            role="radio"
                            aria-checked={option.id === display}
                            className={`sv-menu-option ${option.id === display ? 'selected' : ''}`}
                            data-sequence-display-option={option.id}
                            onClick={() => choose(option.id)}
                        >
                            <strong>{option.label}</strong>
                            <small>{option.hint}</small>
                        </button>
                    ))}
                </div>

                <div className="sv-menu-section">
                    <label className="sv-menu-check">
                        <input
                            type="checkbox"
                            checked={colour}
                            disabled={!plain}
                            data-sequence-display-colour="true"
                            onChange={(event) => onColour?.(event.target.checked)}
                        />
                        Colour the bases
                    </label>
                    <small className="sv-menu-note">
                        {plain
                            ? 'The letters are inked in the same classes the interactive display '
                                + 'fills its cells with. Turned off, the sequence is one colour and '
                                + 'the text is the whole of what is on the screen.'
                            : 'For the plain displays. The interactive display is always coloured — '
                                + 'the Colour control says in what.'}
                    </small>
                </div>

                {plain ? (
                    <div className="sv-menu-section">
                        <small>
                            Plain displays draw the bases and nothing over them: no protein lane, no
                            gene marks, no highlight and no base boxes. Selecting, copying and finding
                            are the browser’s own, over the rows on the screen.
                        </small>
                    </div>
                ) : null}
            </ControlMenu>
        </>
    )
}

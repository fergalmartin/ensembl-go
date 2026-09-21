import { useCallback, useId, useRef, useState } from 'react'

import { menuPosition, useMenuDismiss } from '../alignment-explorer/menuAnchor'
import { genomePillColors } from '../../utils/genomePillColors'
import { ControlChevron, ControlMenu } from './ControlChrome'

/**
 * Which genome is being read, and the way to another.
 *
 * The pill, not a drop-down list of names. The genome a reader is looking at is
 * the same object here as it is in the top bar, the browser and the explorer,
 * and it is recognised by its colour long before its name has been read -- a
 * `<select>` threw all of that away and gave back a line of grey text.
 *
 * Pressing it drops a list of the active genomes, each as its own pill, with a
 * mark against the one in hand. The pills are compressed, as they are on the
 * browser's toolbars: an assembly name can be longer than anything a bar has
 * room for, and the whole label is on the tooltip.
 */
export default function GenomeTool({ options = [], genomeKey, isLight, root, onChange }) {
    const [anchor, setAnchor] = useState(null)
    const button = useRef(null)
    const menuId = useId()
    const close = useCallback(() => setAnchor(null), [])
    useMenuDismiss(Boolean(anchor), close, button, 'sv-menu')

    const current = options.find((option) => option.key === genomeKey) || options[0] || null
    if (!current) return null

    const open = () => {
        if (anchor) close()
        else setAnchor(menuPosition(button.current, 340, 'sv'))
    }

    const choose = (key) => {
        close()
        if (key !== genomeKey) onChange?.(key)
    }

    return (
        <>
            <button
                ref={button}
                type="button"
                className={`sv-genome ${anchor ? 'menu-open' : ''}`}
                data-sequence-genome="true"
                aria-haspopup="dialog"
                aria-expanded={Boolean(anchor)}
                aria-controls={anchor ? menuId : undefined}
                onClick={open}
                title={`${current.pill.tooltip || current.label} — press to read another genome`}
            >
                <GenomeChip pill={current.pill} isLight={isLight} state="active" />
                <ControlChevron />
            </button>

            <ControlMenu id={menuId} root={root} anchor={anchor} title="Genome">
                <div className="sv-genome-list" role="radiogroup" aria-label="Genome">
                    {options.map((option) => {
                        const chosen = option.key === genomeKey
                        return (
                            <button
                                key={option.key}
                                type="button"
                                role="radio"
                                aria-checked={chosen}
                                className={`sv-genome-row ${chosen ? 'selected' : ''}`}
                                data-sequence-genome-option={option.key}
                                onClick={() => choose(option.key)}
                                title={option.pill.tooltip || option.label}
                            >
                                <span className="sv-genome-tick" aria-hidden="true" />
                                <GenomeChip
                                    pill={option.pill}
                                    isLight={isLight}
                                    state={chosen ? 'active' : 'inactive'}
                                />
                                {/* Where it will open, for a genome the reader
                                    has been looking at somewhere else. Said
                                    here because the switch acts on it. */}
                                {option.at ? <small className="sv-genome-at">{option.at}</small> : null}
                            </button>
                        )
                    })}
                </div>
            </ControlMenu>
        </>
    )
}

/** One genome, worn the way the rest of the app wears it. */
function GenomeChip({ pill, isLight, state }) {
    const colours = genomePillColors(pill.colour, { isLight, state })
    return (
        <span
            className="sv-genome-pill"
            style={{
                backgroundColor: colours.backgroundColor,
                color: colours.textColor,
                borderColor: colours.borderColor,
            }}
        >
            <span className="sv-genome-name">{pill.name}</span>
            {pill.assembly ? <span className="sv-genome-assembly">{pill.assembly}</span> : null}
        </span>
    )
}

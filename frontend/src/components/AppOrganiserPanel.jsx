import { useCallback, useMemo, useRef, useState } from 'react'

import AppButtonIcon from './AppButtonIcon.jsx'
import {
    ACTION_BUTTON_IDS,
    APP_BUTTON_META,
    DATA_VIEW_BUTTON_IDS,
    DEFAULT_ACTIVE_APP_BUTTONS,
    NON_DEACTIVATABLE_APP_BUTTON_IDS,
    TOP_BAR_BUTTON_PX,
    TOP_BAR_GAP_PX,
    TOP_BAR_VIEWPORT_PX,
    buildAppButtonLayout,
} from '../appButtonConfig.js'

/**
 * The app organiser: activate, deactivate and reorder the buttons of the top app bar.
 *
 * Lives in its own component because it now has two homes — the Configuration view's
 * "Organise Apps" section and the drawer under the top bar itself — and two copies of
 * this would drift apart the first time either changed.
 *
 * `onChange` is the only way out: it takes the next button list, or an updater given
 * the current one, exactly like a state setter. Each host decides where that list is
 * stored. `onNotice` is optional; without it the panel says its own piece inline.
 *
 * `previewScrollRef` hands the active grid's scroll container back to the host, which
 * the top bar uses to keep the preview and the real bar scrolled to the same place.
 */
export default function AppOrganiserPanel({
    theme,
    activeAppButtons,
    onChange,
    onNotice,
    previewScrollRef = null,
    className = '',
}) {
    const isLight = theme === 'light'
    const [inactiveDataPriority, setInactiveDataPriority] = useState(DATA_VIEW_BUTTON_IDS)
    const [inactiveActionPriority, setInactiveActionPriority] = useState(ACTION_BUTTON_IDS)
    const [draggedButtonId, setDraggedButtonId] = useState(null)
    const [dragOverButtonId, setDragOverButtonId] = useState(null)
    const [inlineNotice, setInlineNotice] = useState(null)
    const dragMovedRef = useRef(false)

    const notify = useCallback((message, isError = false) => {
        if (onNotice) {
            onNotice(message, isError)
            return
        }
        setInlineNotice({ message, isError })
    }, [onNotice])

    // A button the user most recently switched off comes back to the front of the
    // inactive row, so undoing a mis-click does not mean hunting for it.
    const orderByPriority = useCallback((ids, priority) => {
        const prioritized = priority.filter((id) => ids.includes(id))
        const remainder = ids.filter((id) => !prioritized.includes(id))
        return [...prioritized, ...remainder]
    }, [])

    const inactiveDataButtons = useMemo(() => {
        const available = DATA_VIEW_BUTTON_IDS.filter((id) => !activeAppButtons.includes(id))
        return orderByPriority(available, inactiveDataPriority)
    }, [activeAppButtons, inactiveDataPriority, orderByPriority])

    const inactiveActionButtons = useMemo(() => {
        const available = ACTION_BUTTON_IDS.filter((id) => !activeAppButtons.includes(id))
        return orderByPriority(available, inactiveActionPriority)
    }, [activeAppButtons, inactiveActionPriority, orderByPriority])

    const activateAppButton = (buttonId) => {
        onChange((prevButtons) => {
            if (prevButtons.includes(buttonId)) return prevButtons
            // The action buttons live at the end of the top bar, so a returning
            // data view goes in front of them rather than after them.
            if (APP_BUTTON_META[buttonId]?.kind === 'action') return [...prevButtons, buttonId]
            const firstActionIndex = prevButtons.findIndex(
                (id) => APP_BUTTON_META[id]?.kind === 'action'
            )
            if (firstActionIndex < 0) return [...prevButtons, buttonId]
            const next = [...prevButtons]
            next.splice(firstActionIndex, 0, buttonId)
            return next
        })
        setInactiveDataPriority((prev) => prev.filter((id) => id !== buttonId))
        setInactiveActionPriority((prev) => prev.filter((id) => id !== buttonId))
    }

    const deactivateAppButton = (buttonId) => {
        if (NON_DEACTIVATABLE_APP_BUTTON_IDS.includes(buttonId)) {
            notify('The Configuration button cannot be deactivated.', true)
            return
        }
        onChange((prevButtons) => {
            if (!prevButtons.includes(buttonId)) return prevButtons
            return prevButtons.filter((id) => id !== buttonId)
        })

        const kind = APP_BUTTON_META[buttonId]?.kind
        if (kind === 'data_view') {
            setInactiveDataPriority((prev) => [buttonId, ...prev.filter((id) => id !== buttonId)])
        } else {
            setInactiveActionPriority((prev) => [buttonId, ...prev.filter((id) => id !== buttonId)])
        }
    }

    const reorderActiveButtons = (sourceButtonId, targetButtonId) => {
        if (!sourceButtonId || !targetButtonId || sourceButtonId === targetButtonId) return
        onChange((prevButtons) => {
            const sourceIndex = prevButtons.indexOf(sourceButtonId)
            const targetIndex = prevButtons.indexOf(targetButtonId)
            if (sourceIndex < 0 || targetIndex < 0) return prevButtons
            const next = [...prevButtons]
            const [moved] = next.splice(sourceIndex, 1)
            next.splice(targetIndex, 0, moved)
            return next
        })
    }

    const resetAppButtonsToDefault = () => {
        onChange(DEFAULT_ACTIVE_APP_BUTTONS)
        setInactiveDataPriority(DATA_VIEW_BUTTON_IDS)
        setInactiveActionPriority(ACTION_BUTTON_IDS)
        notify('App button layout reset to default')
    }

    const activeLayout = useMemo(() => buildAppButtonLayout(activeAppButtons), [activeAppButtons])

    const subLabel = `text-xs uppercase tracking-wider font-bold ${isLight ? 'text-gray-500' : 'text-gray-400'}`
    const subHint = `text-xs mt-0.5 mb-2 ${isLight ? 'text-gray-500' : 'text-gray-400'}`
    const divider = `border-t my-5 ${isLight ? 'border-gray-100' : 'border-gray-700'}`
    const btnSecondary = `px-4 py-2 rounded-lg text-sm font-semibold transition-colors flex items-center justify-center gap-2 ${isLight
        ? 'bg-gray-200 text-gray-700 hover:bg-gray-300 border border-gray-300'
        : 'bg-gray-700 text-gray-300 hover:bg-gray-600 border border-gray-600'}`
    const iconButtonBase = 'relative rounded-lg flex items-center justify-center transition-all duration-200 border-2 cursor-pointer shrink-0'
    const iconButtonSize = { width: TOP_BAR_BUTTON_PX, height: TOP_BAR_BUTTON_PX }
    const appIconButtonActive = `${iconButtonBase} text-white bg-[#0099ff] hover:bg-[#0088ee] border-transparent`
    const appIconButtonActionActive = `${iconButtonBase} bg-[#bfe6ff] text-[#006fbf] hover:bg-[#cbeeff] border-[#0099ff]`
    const appIconButtonInactive = `${iconButtonBase} ${isLight
        ? 'bg-gray-300 text-gray-700 hover:bg-gray-400 border-gray-400'
        : 'bg-gray-700 text-gray-300 hover:bg-gray-600 border-gray-600'}`
    const appIconButtonActionInactive = `${iconButtonBase} bg-[#e1f4ff] text-[#0077cc] hover:text-[#005f9f] hover:bg-[#cbeeff] border-[#0099ff]`
    const inactiveRowClass = 'flex flex-wrap gap-2'
    const emptyNote = `text-sm ${isLight ? 'text-gray-500' : 'text-gray-400'}`

    const renderInactiveGroup = (ids, buttonClass, emptyText, keyPrefix) => (
        <>
            <p className={subHint}>Click to activate</p>
            <div className={inactiveRowClass}>
                {ids.length === 0 && <div className={emptyNote}>{emptyText}</div>}
                {ids.map((buttonId) => {
                    const meta = APP_BUTTON_META[buttonId]
                    if (!meta) return null
                    return (
                        <button
                            key={`${keyPrefix}-${buttonId}`}
                            type="button"
                            onClick={() => activateAppButton(buttonId)}
                            className={buttonClass}
                            style={iconButtonSize}
                            title={meta.label}
                        >
                            <AppButtonIcon buttonId={buttonId} isLight={isLight} />
                        </button>
                    )
                })}
            </div>
        </>
    )

    return (
        <div className={className}>
            {inlineNotice && (
                <p className={`text-xs mb-3 ${inlineNotice.isError
                    ? (isLight ? 'text-red-600' : 'text-red-400')
                    : (isLight ? 'text-[#0077cc]' : 'text-blue-300')}`}
                >
                    {inlineNotice.message}
                </p>
            )}

            <p className={subLabel}>Active buttons</p>
            <p className={subHint}>Click to deactivate, drag to rearrange</p>
            {/* Laid out in the rows and columns the top bar will actually use, so this
                reads as a preview of the bar rather than as an unrelated grid. */}
            <div ref={previewScrollRef} className="overflow-x-auto hide-scrollbar" style={{ maxWidth: TOP_BAR_VIEWPORT_PX }}>
                <div className="flex flex-col gap-2 w-max">
                {activeLayout.rows.map((row, rowIndex) => (
                <div
                    key={`organiser-row-${rowIndex}`}
                    className="grid gap-2 justify-items-start"
                    style={{ gridTemplateColumns: `repeat(${activeLayout.columns}, ${TOP_BAR_BUTTON_PX}px)` }}
                >
                {row.map((buttonId) => {
                    const meta = APP_BUTTON_META[buttonId]
                    if (!meta) return null
                    const isLocked = NON_DEACTIVATABLE_APP_BUTTON_IDS.includes(buttonId)
                    return (
                        <button
                            key={`active-${buttonId}`}
                            type="button"
                            draggable
                            onClick={() => {
                                if (dragMovedRef.current) {
                                    dragMovedRef.current = false
                                    return
                                }
                                deactivateAppButton(buttonId)
                            }}
                            onDragStart={(event) => {
                                event.dataTransfer.effectAllowed = 'move'
                                event.dataTransfer.setData('text/plain', buttonId)
                                setDraggedButtonId(buttonId)
                                setDragOverButtonId(buttonId)
                                dragMovedRef.current = false
                            }}
                            onDragEnter={(event) => {
                                event.preventDefault()
                                if (draggedButtonId && draggedButtonId !== buttonId) {
                                    setDragOverButtonId(buttonId)
                                    dragMovedRef.current = true
                                }
                            }}
                            onDragOver={(event) => event.preventDefault()}
                            onDrop={(event) => {
                                event.preventDefault()
                                const source = draggedButtonId || event.dataTransfer.getData('text/plain')
                                reorderActiveButtons(source, buttonId)
                                setDraggedButtonId(null)
                                setDragOverButtonId(null)
                                dragMovedRef.current = false
                            }}
                            onDragEnd={() => {
                                setDraggedButtonId(null)
                                setDragOverButtonId(null)
                                setTimeout(() => { dragMovedRef.current = false }, 0)
                            }}
                            className={`${meta.kind === 'action' ? appIconButtonActionActive : appIconButtonActive} ${draggedButtonId === buttonId ? 'opacity-50 scale-[0.98]' : ''} ${dragOverButtonId === buttonId && draggedButtonId !== buttonId ? (isLight ? 'ring-2 ring-[#0099ff]/70' : 'ring-2 ring-blue-300/80') : ''}`}
                            style={iconButtonSize}
                            title={isLocked ? `${meta.label} (cannot be deactivated)` : meta.label}
                        >
                            <AppButtonIcon buttonId={buttonId} isLight={isLight} />
                            {isLocked && (
                                <span className={`absolute -top-1 -right-1 text-[8px] px-1.5 py-0.5 rounded-full ${isLight ? 'bg-white text-[#0077cc] border border-[#0077cc]/30' : 'bg-gray-900 text-blue-300 border border-blue-400/40'}`}>
                                    lock
                                </span>
                            )}
                        </button>
                    )
                })}
                </div>
                ))}
                </div>
            </div>

            <div className={divider} />

            <p className={subLabel}>Inactive data views</p>
            {renderInactiveGroup(inactiveDataButtons, appIconButtonInactive, 'No inactive data views.', 'inactive-data')}

            <div className={`my-4 border-t ${isLight ? 'border-gray-100' : 'border-gray-700'}`} />

            <p className={subLabel}>Inactive action buttons</p>
            {renderInactiveGroup(inactiveActionButtons, appIconButtonActionInactive, 'No inactive action buttons.', 'inactive-action')}

            <div className={divider} />

            <div className="flex gap-3">
                <button type="button" onClick={resetAppButtonsToDefault} className={btnSecondary}>
                    Reset App Buttons to Default
                </button>
            </div>
        </div>
    )
}

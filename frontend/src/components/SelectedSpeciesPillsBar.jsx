import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import useHorizontalPillScroll from './useHorizontalPillScroll'
import { getGenomeKey } from '../utils/genomeIdentity'
import { genomeColorResolver } from '../genomeColorSchemes'
import { genomePillColors } from '../utils/genomePillColors'
import GenomePill, { genomePillLabels } from './GenomePill'

function formatScientificName(species) {
    if (species.display_name) return species.display_name
    if (species.common_name) return species.common_name

    const name = species.scientific_name
    if (!name) return ''
    const parts = name.split(' ')
    if (parts.length >= 2) {
        return `${parts[0].charAt(0)}. ${parts.slice(1).join(' ')}`
    }
    return name
}

function formatAssembly(assemblyName, truncate = true) {
    if (!assemblyName) return ''
    if (truncate && assemblyName.length > 10) {
        return assemblyName.substring(0, 7) + '...'
    }
    return assemblyName
}

function itemKey(species) {
    return getGenomeKey(species)
}

/** The height of the pills themselves: 12px text on a 16px line with `py-1.5` and a 1px
 *  border, plus the 8px their wrapper leaves beneath for the assembly badge.
 *
 *  Anything standing in for the pills — the message shown when there are none — is given
 *  this height too, so the strip is exactly as tall empty as it is full and nothing below
 *  it moves when the first genome arrives. */
export const PILL_CONTENT_HEIGHT = 38

/** The height of one row of pills, for a caller that needs the strip to hold its place
 *  while it is still empty. The row adds `pt-1 pb-0.5` around the pills.
 *
 *  Declared here, beside the markup it describes, so the two cannot drift apart
 *  unnoticed. */
export const PILLS_ROW_HEIGHT = PILL_CONTENT_HEIGHT + 4 + 2

export default function SelectedSpeciesPillsBar({
    theme = 'dark',
    config,
    onToggleSpecies,
    onRemoveSpecies,
    onReorderSpecies = null,
    mode = 'all',
    selectedSpeciesKeys = null,
    semiSelectedSpeciesKeys = null,
    speciesList = null,
    primarySpeciesKey = '',
    nonPrimarySelectedColor = '',
    reserveRowHeight = false,
    emptyState = null,
    // Pinned to the right end of the strip, after the scroll arrow (the Active tasks
    // button). The strip gives up its width, so pills it would cover scroll instead.
    trailing = null,
}) {
    const isLight = theme === 'light'
    const resolveGenomeColor = useMemo(() => genomeColorResolver(config), [config])
    const [pillToast, setPillToast] = useState(null)

    const pillToastTimerRef = useRef(null)
    const [draggedPillKey, setDraggedPillKey] = useState('')
    const [dragOverPillKey, setDragOverPillKey] = useState('')
    const [dragInsertPosition, setDragInsertPosition] = useState('before')
    const {
        scrollRef: pillsScrollRef,
        suppressClickRef: suppressPillClickRef,
        handleScroll: handleScrollPills,
        onMouseDown: onPillMouseDown,
        onMouseMove: onPillMouseMove,
        onMouseUp: onPillMouseUp,
        isOverflowing: pillsOverflow,
        canScrollLeft: canScrollPillsLeft,
        canScrollRight: canScrollPillsRight,
    } = useHorizontalPillScroll({ scrollAmount: 200 })

    useEffect(() => {
        return () => {
            if (pillToastTimerRef.current) {
                window.clearTimeout(pillToastTimerRef.current)
            }
        }
    }, [])

    const allSpecies = useMemo(() => {
        const raw = Array.isArray(speciesList) ? speciesList : (config?.active_species || [])
        const out = []
        const seen = new Set()
        for (const item of raw) {
            const key = itemKey(item)
            if (seen.has(key)) continue
            seen.add(key)
            out.push(item)
        }
        return out
    }, [speciesList, config?.active_species])

    const selectedKeysSet = useMemo(() => {
        if (selectedSpeciesKeys instanceof Set) return selectedSpeciesKeys
        return new Set()
    }, [selectedSpeciesKeys])
    const semiSelectedKeysSet = useMemo(() => {
        if (semiSelectedSpeciesKeys instanceof Set) return semiSelectedSpeciesKeys
        return new Set()
    }, [semiSelectedSpeciesKeys])

    const inactiveSpecies = useMemo(() => {
        return allSpecies.filter((species) => !selectedKeysSet.has(itemKey(species)))
    }, [allSpecies, selectedKeysSet])

    const showInactiveOnly = mode === 'inactive_only'
    const speciesToRender = showInactiveOnly ? inactiveSpecies : allSpecies

    const handlePillClick = useCallback(async (species) => {
        if (suppressPillClickRef.current) return
        if (!onToggleSpecies) return
        const result = await onToggleSpecies(species)
        if (result?.ok === false) {
            const msg = result?.message || (result?.reason === 'view_limit_reached'
                ? 'Deactivate one active genome in this view first.'
                : 'Unable to update genome selection.')
            setPillToast({ msg })
            if (pillToastTimerRef.current) window.clearTimeout(pillToastTimerRef.current)
            pillToastTimerRef.current = window.setTimeout(() => setPillToast(null), 3000)
        }
    }, [onToggleSpecies])

    const handlePillDrop = useCallback((sourceKey, targetKey, insertPosition) => {
        if (!onReorderSpecies) return
        const sourceSpecies = allSpecies.find((species) => itemKey(species) === sourceKey)
        const targetSpecies = allSpecies.find((species) => itemKey(species) === targetKey)
        if (!sourceSpecies || !targetSpecies) return
        onReorderSpecies({
            source: sourceSpecies,
            target: targetSpecies,
            sourceKey,
            targetKey,
            insertPosition: insertPosition === 'after' ? 'after' : 'before',
        })
    }, [allSpecies, onReorderSpecies])

    return (
        <div className="flex items-center gap-3 min-w-0">
            <div className="flex items-center flex-1 min-w-0 overflow-visible">
                {pillsOverflow && (
                    <button
                        onClick={() => handleScrollPills('left')}
                        disabled={!canScrollPillsLeft}
                        className={`flex-shrink-0 p-1 rounded transition-colors ${canScrollPillsLeft
                            ? (isLight ? 'text-gray-500 hover:bg-gray-200 hover:text-gray-900' : 'text-gray-400 hover:bg-gray-700 hover:text-gray-100')
                            : (isLight ? 'text-gray-300 cursor-default' : 'text-gray-600 cursor-default')}`}
                        title="Scroll Left"
                    >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="15 18 9 12 15 6"></polyline>
                        </svg>
                    </button>
                )}

                <div
                    ref={pillsScrollRef}
                    className="hide-scrollbar flex items-center gap-1.5 flex-1 px-1 pt-1 pb-0.5 overflow-x-auto overflow-y-visible cursor-grab select-none"
                    style={reserveRowHeight ? { minHeight: PILLS_ROW_HEIGHT } : undefined}
                    onMouseDown={onPillMouseDown}
                    onMouseMove={onPillMouseMove}
                    onMouseUp={onPillMouseUp}
                    onMouseLeave={onPillMouseUp}
                >
                    {(speciesToRender.length === 0) ? (
                        // Held to the pills' own height so the strip does not change size
                        // when the first genome lands in it.
                        <div
                            className={`flex items-center text-xs ${isLight ? 'text-gray-500' : 'text-gray-400'}`}
                            style={{ minHeight: PILL_CONTENT_HEIGHT }}
                        >
                            {emptyState || (showInactiveOnly ? 'Deactivate a genome to return it to the list' : 'No genomes in list.')}
                        </div>
                    ) : (
                        speciesToRender.map((species) => {
                            const speciesKey = itemKey(species)
                            const isSelected = selectedKeysSet.has(speciesKey)
                            const isSemiSelected = !isSelected && semiSelectedKeysSet.has(speciesKey)
                            const isDragging = draggedPillKey === speciesKey
                            const isDropTarget = Boolean(
                                draggedPillKey &&
                                dragOverPillKey &&
                                draggedPillKey !== speciesKey &&
                                dragOverPillKey === speciesKey
                            )

                            // Every pill is drawn in its own genome's colour, in one of
                            // three strengths: solid where the genome is on screen in this
                            // view, hollow where it is in the session but not shown here,
                            // and grey-with-a-tinted-edge where it is neither. So a pill
                            // says both which genome it is and how far in it is, and the
                            // pill matches that genome's browser panel either way.
                            //
                            // A caller that overrides the non-primary colour (the dual-view
                            // strips) still wins for the pills it names.
                            const useNonPrimaryAccent = Boolean(nonPrimarySelectedColor) && speciesKey !== primarySpeciesKey
                            const pillAccent = useNonPrimaryAccent && isSelected
                                ? nonPrimarySelectedColor
                                : resolveGenomeColor(species)
                            const pillState = isSelected ? 'active' : (isSemiSelected ? 'inactive' : 'available')
                            const {
                                backgroundColor: bgClass,
                                textColor: textClass,
                                borderColor: borderClass,
                            } = genomePillColors(pillAccent, { isLight, state: pillState })

                            const assemblyName = species.assembly_name || species.assembly
                            const displayName = (isSelected || isSemiSelected)
                                ? (species.display_name || species.common_name || species.scientific_name || '')
                                : formatScientificName(species)
                            const displayAssembly = (isSelected || isSemiSelected)
                                ? assemblyName
                                : formatAssembly(assemblyName)
                            // The cross is knocked out of the pill's own fill. Every
                            // state now has an opaque one — the hollow pill is a wash of
                            // its colour rather than nothing — so there is no transparent
                            // case left to fall back from.
                            // For a non-Ensembl genome the badge names the provider
                            // rather than its release, so the release only survives
                            // in the tooltip — where both are always spelled out.
                            const { badge: datasetBadge, badgeTooltip, pillTooltip: tooltipProps } = genomePillLabels(species)

                            return (
                                <div
                                    key={speciesKey}
                                    data-tour-id={`genome-pill-${species?.species_key || ''}`}
                                    className="relative flex-shrink-0 group/pill"
                                    draggable
                                    onDragStart={(event) => {
                                        event.dataTransfer.effectAllowed = 'move'
                                        event.dataTransfer.setData('text/plain', speciesKey)
                                        setDraggedPillKey(speciesKey)
                                        setDragOverPillKey(speciesKey)
                                        setDragInsertPosition('before')
                                        suppressPillClickRef.current = true
                                    }}
                                    onDragOver={(event) => {
                                        if (!draggedPillKey || draggedPillKey === speciesKey) return
                                        event.preventDefault()
                                        event.dataTransfer.dropEffect = 'move'
                                        const rect = event.currentTarget.getBoundingClientRect()
                                        const nextInsertPosition = event.clientX < (rect.left + rect.width / 2) ? 'before' : 'after'
                                        setDragOverPillKey(speciesKey)
                                        setDragInsertPosition(nextInsertPosition)
                                    }}
                                    onDrop={(event) => {
                                        event.preventDefault()
                                        const source = draggedPillKey || event.dataTransfer.getData('text/plain')
                                        handlePillDrop(source, speciesKey, dragInsertPosition)
                                        setDraggedPillKey('')
                                        setDragOverPillKey('')
                                        setDragInsertPosition('before')
                                        window.setTimeout(() => { suppressPillClickRef.current = false }, 0)
                                    }}
                                    onDragEnd={() => {
                                        setDraggedPillKey('')
                                        setDragOverPillKey('')
                                        setDragInsertPosition('before')
                                        window.setTimeout(() => { suppressPillClickRef.current = false }, 0)
                                    }}
                                    style={{
                                        opacity: isDragging ? 0.55 : 1,
                                        paddingBottom: 8,
                                        boxShadow: isDropTarget
                                            ? (dragInsertPosition === 'before'
                                                ? `inset 3px 0 0 ${isLight ? 'rgba(0, 119, 204, 0.92)' : 'rgba(125, 211, 252, 0.92)'}`
                                                : `inset -3px 0 0 ${isLight ? 'rgba(0, 119, 204, 0.92)' : 'rgba(125, 211, 252, 0.92)'}`)
                                            : undefined,
                                        }}
                                    >
                                    <GenomePill
                                        tutorialDatasetId={species?.tutorial_dataset_id}
                                        tutorialEngaged={isSelected}
                                        displayName={displayName}
                                        displayAssembly={displayAssembly}
                                        badge={datasetBadge}
                                        badgeTooltip={badgeTooltip}
                                        tooltip={tooltipProps}
                                        isLight={isLight}
                                        backgroundColor={bgClass}
                                        textColor={textClass}
                                        borderColor={borderClass}
                                        minWidth={isSelected ? 'auto' : '110px'}
                                        maxWidth={isSelected ? '320px' : '180px'}
                                        // Room for the remove disc, which sits inside the
                                        // pill rather than hanging off its corner.
                                        paddingLeft={onRemoveSpecies ? 28 : undefined}
                                        onClick={() => handlePillClick(species)}
                                    />
                                    {onRemoveSpecies && (
                                        <button
                                            data-tour-id={`genome-pill-remove-${species?.species_key || ''}`}
                                            type="button"
                                            onMouseDown={(e) => e.stopPropagation()}
                                            onClick={(e) => {
                                                e.stopPropagation()
                                                onRemoveSpecies(species)
                                            }}
                                            // Always on rather than revealed on hover: a control
                                            // that only exists under the cursor is one nobody
                                            // finds. Filled in the pill's own text colour with
                                            // the cross knocked out in its background, so it
                                            // stays legible whatever the pill's state.
                                            className="absolute left-[7px] w-[17px] h-[17px] rounded-full flex items-center justify-center transition-opacity hover:opacity-80"
                                            style={{
                                                // Centred on the pill, not on the wrapper: the
                                                // wrapper carries bottom padding for the dataset
                                                // badge, so a plain 50% sits high.
                                                top: 0,
                                                bottom: 8,
                                                marginTop: 'auto',
                                                marginBottom: 'auto',
                                                backgroundColor: textClass,
                                                color: bgClass,
                                            }}
                                            title="Remove genome from list"
                                            aria-label="Remove genome from list"
                                        >
                                            <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                                                <line x1="2.4" y1="2.4" x2="7.6" y2="7.6" />
                                                <line x1="7.6" y1="2.4" x2="2.4" y2="7.6" />
                                            </svg>
                                        </button>
                                    )}
                                </div>
                            )
                        })
                    )}
                </div>

                {pillsOverflow && (
                    <button
                        onClick={() => handleScrollPills('right')}
                        disabled={!canScrollPillsRight}
                        className={`flex-shrink-0 p-1 rounded transition-colors ${canScrollPillsRight
                            ? (isLight ? 'text-gray-500 hover:bg-gray-200 hover:text-gray-900' : 'text-gray-400 hover:bg-gray-700 hover:text-gray-100')
                            : (isLight ? 'text-gray-300 cursor-default' : 'text-gray-600 cursor-default')}`}
                        title="Scroll Right"
                    >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="9 18 15 12 9 6"></polyline>
                        </svg>
                    </button>
                )}

                {trailing ? (
                    // Padded as a pill is: the scroller's `pt-1 pb-0.5` plus the 8px each
                    // pill leaves beneath itself for its badge. So the button lines up
                    // with the pills, not with the middle of the strip.
                    <div className="flex-shrink-0 flex items-center pl-1.5 empty:hidden" style={{ paddingTop: 4, paddingBottom: 10 }}>
                        {trailing}
                    </div>
                ) : null}
            </div>

            {pillToast && (
                <div
                    className="flex-shrink-0 flex items-center gap-1.5 text-xs px-3 py-1 rounded-full font-medium"
                    style={{
                        backgroundColor: isLight ? '#fff3cd' : '#3d2c00',
                        color: isLight ? '#92400e' : '#fbbf24',
                        border: '1px solid',
                        borderColor: isLight ? '#fcd34d' : '#78350f'
                    }}
                >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <circle cx="12" cy="12" r="10" />
                        <line x1="12" y1="8" x2="12" y2="12" />
                        <line x1="12" y1="16" x2="12.01" y2="16" />
                    </svg>
                    {pillToast.msg}
                </div>
            )}
        </div>
    )
}

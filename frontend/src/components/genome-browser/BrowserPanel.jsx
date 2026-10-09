// The rendered Genome Browser panel: label modal, track picker, canvas surface,
// gutter controls, popups and tooltips, footer and note overlays. Returned by the
// panel component (a plain call, not a separate component).
import { Fragment } from 'react'
import { getBaseColor } from '../../utils/nucleotideStyle.js'
import GeneIndexProgressOverlay from '../GeneIndexProgressOverlay'
import NoteGlyph from '../NoteGlyph'
import {
    DEFAULT_CUSTOM_TRACK_RENDER_MODE,
    EXPANDED_FOOTER_LABEL_TOP_OFFSET,
    LHS_WIDTH,
    NOTE_BUBBLE_SIZE,
    TRACK_PICKER_GROUP_PREFIX,
    gutterMarkerStyle,
    pickerRowClass,
} from './browserConstants.js'
import { formatCoord } from './browserFormat.js'
import { TRANSCRIPT_FOOTER_CONTROL_HEIGHT } from './genomeBrowserLabelLayout.js'
import { formatSpliceMotifForDisplay } from './spliceGeometry.js'

export function renderBrowserPanel(ctx) {
    const {
        CONTROL_GAP_PX,
        PickerRowButton,
        TranscriptInfoPopup,
        applyTrackPickerChanges,
        availableGroups,
        availableTracks,
        canConfirmCustomTrack,
        canvasRef,
        chromLabel,
        clearTranscriptPopupDismissTimer,
        clickedBigBedFeature,
        clickedGeneTranscript,
        clickedSeqBase,
        clickedSpliceJunction,
        clickedVcfVariant,
        closeTrackPicker,
        colors,
        containerRef,
        customTrackHoverTooltip,
        customTrackLabelInput,
        customTrackRenderModeInput,
        customTracks,
        customTracksById,
        effectiveFocusBarPosition,
        effectiveToolbarPosition,
        fetchTranscripts,
        geneIndexOverlayGeometry,
        geneIndexStatus,
        geneNoteOverlay,
        genome,
        genomePillLabel,
        getCustomTrackToggleY,
        gutterMarkerHeight,
        handleCanvasClick,
        handleConfirmAddCustomTrack,
        handleContainerMouseLeave,
        handleKeyDown,
        handleMouseDown,
        handleMouseMove,
        handleMouseUp,
        hiddenStrands,
        isBoxSelectMode,
        isCustomTrackLabelModalOpen,
        isDragging,
        isLight,
        isSelectingRect,
        isTrackPickerOpen,
        keyboardHintId,
        keyboardHintText,
        label,
        layout,
        loadingGenes,
        onFocusTranscriptViewChangeRef,
        onGeneTranscriptViewChangeRef,
        onOpenGeneNotesRef,
        panelPillColor,
        pendingPickerRemovals,
        pickerHasChanges,
        registryTracksById,
        requestTranscriptPillFocus,
        retryGeneIndex,
        rootRef,
        scheduleTranscriptPopupDismiss,
        screenshotTargetId,
        selectedChrom,
        selectedGeneInfoBar,
        selectedLocationInfoBar,
        selectedTrackPickerIds,
        setCustomTrackLabelInput,
        setCustomTrackRenderModeInput,
        setCustomTracks,
        setExpandedGenes,
        setHiddenStrands,
        setIsCustomTrackLabelModalOpen,
        setPendingCustomTrackPath,
        setSelectedGene,
        showInitialLoadingOverlay,
        showSequenceTrack,
        sidebarTooltip,
        togglePickerChange,
        toolbar,
        transcriptCache,
        transcriptFooterOverlay,
        transcriptPopupHoverRef,
        tutorialAnchorsActive,
        viewWidth,
    } = ctx
    return (
<div
            ref={rootRef}
            className="relative flex flex-col"
            style={{ flex: '1 0 auto', minHeight: 0 }}
        >

            {isCustomTrackLabelModalOpen && (
                <div data-wheel-isolated="true" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
                    <div
                        className={`w-full max-w-md rounded-xl shadow-2xl border ${isLight ? 'bg-white border-gray-200' : 'bg-gray-800 border-gray-700'}`}
                    >
                        <div className={`px-4 py-3 border-b ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
                            <h3 className={`text-sm font-semibold ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>Custom BigWig Label</h3>
                            <p className={`text-xs mt-1 ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>Choose a label for the new track.</p>
                        </div>
                        <div className="p-4">
                            <input
                                type="text"
                                value={customTrackLabelInput}
                                onChange={(e) => setCustomTrackLabelInput(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' && canConfirmCustomTrack) handleConfirmAddCustomTrack()
                                    if (e.key === 'Escape') {
                                        setIsCustomTrackLabelModalOpen(false)
                                        setPendingCustomTrackPath('')
                                        setCustomTrackRenderModeInput(DEFAULT_CUSTOM_TRACK_RENDER_MODE)
                                    }
                                }}
                                className={`w-full px-3 py-2 rounded-lg text-sm border focus:outline-none focus:ring-2 ${isLight
                                    ? 'bg-white border-gray-300 focus:ring-blue-500/40 focus:border-blue-500'
                                    : 'bg-gray-700 border-gray-600 text-gray-100 focus:ring-blue-500/40 focus:border-blue-500'
                                    }`}
                                placeholder=""
                                autoFocus
                            />
                            <div className="mt-3">
                                <label className={`block text-xs mb-1 ${isLight ? 'text-gray-600' : 'text-gray-300'}`}>
                                    Rendering mode
                                </label>
                                <select
                                    value={customTrackRenderModeInput}
                                    onChange={(e) => setCustomTrackRenderModeInput(e.target.value)}
                                    className={`w-full px-3 py-2 rounded-lg text-sm border focus:outline-none focus:ring-2 ${isLight
                                        ? 'bg-white border-gray-300 focus:ring-blue-500/40 focus:border-blue-500'
                                        : 'bg-gray-700 border-gray-600 text-gray-100 focus:ring-blue-500/40 focus:border-blue-500'
                                        }`}
                                >
                                    <option value="zoned_heatmap">Zoned Heat Map</option>
                                    <option value="signal_plot">Signal Plot</option>
                                </select>
                            </div>
                        </div>
                        <div className={`px-4 py-3 border-t flex justify-end gap-2 ${isLight ? 'border-gray-200 bg-gray-50' : 'border-gray-700 bg-gray-900/30'}`}>
                            <button
                                onClick={() => {
                                    setIsCustomTrackLabelModalOpen(false)
                                    setPendingCustomTrackPath('')
                                    setCustomTrackRenderModeInput(DEFAULT_CUSTOM_TRACK_RENDER_MODE)
                                }}
                                className={`px-3 py-1.5 rounded-md text-sm ${isLight ? 'text-gray-700 hover:bg-gray-200' : 'text-gray-300 hover:bg-gray-700'}`}
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleConfirmAddCustomTrack}
                                disabled={!canConfirmCustomTrack}
                                className="px-3 py-1.5 rounded-md text-sm text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                                Add Track
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* ── Track Picker Modal ─────────────────────────────────────────────────── */}
            {isTrackPickerOpen && (
                <div
                    data-wheel-isolated="true"
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
                    onClick={closeTrackPicker}
                >
                    <div
                        data-tour-id="browser-track-picker"
                        role="dialog"
                        aria-modal="true"
                        aria-label="Add registered track"
                        className={`w-full max-w-lg rounded-2xl shadow-2xl border flex flex-col max-h-[80vh] ${isLight ? 'bg-white border-gray-200' : 'bg-gray-900 border-gray-700'}`}
                        onClick={(e) => e.stopPropagation()}
                    >
                        {/* Header */}
                        <div className={`px-5 py-3.5 border-b flex items-center justify-between flex-none ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
                            <div>
                                <h3 className={`text-sm font-semibold ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>Add Registered Track</h3>
                                <p className={`text-xs mt-0.5 ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                    {availableTracks.length === 0
                                        ? 'No tracks registered. Go to Track Manager to register tracks.'
                                        : `${availableTracks.length} track${availableTracks.length !== 1 ? 's' : ''}${availableGroups.length ? ` and ${availableGroups.length} group${availableGroups.length !== 1 ? 's' : ''}` : ''} available`
                                    }
                                </p>
                            </div>
                            <button
                                onClick={closeTrackPicker}
                                className={`p-1.5 rounded-lg ${isLight ? 'text-gray-500 hover:bg-gray-100' : 'text-gray-400 hover:bg-gray-800'}`}
                            >✕</button>
                        </div>
                        {/* Track list */}
                        <div data-tour-id="browser-track-picker-list" className="flex-1 overflow-y-auto p-3 space-y-1.5">
                            {availableGroups.length > 0 && (
                                <div className={`px-1 text-[10px] font-semibold uppercase tracking-wide ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>Track groups</div>
                            )}
                            {availableGroups.map((group) => {
                                const onPanel = customTracks.filter((ct) => ct.group?.id === group.id)
                                const isOnPanel = onPanel.length > 0
                                const memberCount = (group.members || []).filter((m) => registryTracksById.has(String(m.track_id))).length
                                const presentIds = new Set(onPanel.map((ct) => String(ct.registryTrackId || '')))
                                const missing = (group.members || []).filter((m) => registryTracksById.has(String(m.track_id)) && !presentIds.has(String(m.track_id))).length
                                const pickerId = `${TRACK_PICKER_GROUP_PREFIX}${group.id}`
                                const pendingAdd = selectedTrackPickerIds.includes(pickerId)
                                const pendingRemove = pendingPickerRemovals.includes(pickerId)
                                const willShow = isOnPanel ? !pendingRemove : pendingAdd
                                const toggle = () => {
                                    if (!isOnPanel && !memberCount) return
                                    togglePickerChange(pickerId, isOnPanel)
                                }
                                const typeCounts = new Map()
                                for (const m of group.members || []) {
                                    const type = registryTracksById.get(String(m.track_id))?.type
                                    if (type) typeCounts.set(type, (typeCounts.get(type) || 0) + 1)
                                }
                                return (
                                    <div
                                        key={group.id}
                                        data-tour-id={`browser-track-picker-group-${group.id}`}
                                        data-tutorial-picker-group={group.label || ''}
                                        data-tutorial-engaged={willShow ? 'true' : 'false'}
                                        aria-pressed={willShow}
                                        role="button"
                                        tabIndex={!isOnPanel && !memberCount ? -1 : 0}
                                        onClick={toggle}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() }
                                        }}
                                        className={pickerRowClass(willShow, isLight)}
                                    >
                                        <div className="flex items-center gap-2">
                                            <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded shrink-0 ${isLight ? 'bg-indigo-100 text-indigo-700 border border-indigo-200' : 'bg-indigo-900/50 text-indigo-300 border border-indigo-800'}`}>
                                                group
                                            </span>
                                            <span className={`text-sm font-medium flex-1 min-w-0 truncate ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>
                                                {group.label}
                                            </span>
                                            {isOnPanel && !pendingRemove && missing > 0 && (
                                                <button
                                                    type="button"
                                                    data-tour-id={`browser-track-picker-group-restore-${group.id}`}
                                                    aria-pressed={pendingAdd}
                                                    onClick={(e) => { e.stopPropagation(); togglePickerChange(pickerId, false) }}
                                                    className={`rounded-md px-1.5 py-1 text-[11px] font-medium ${pendingAdd
                                                        ? isLight ? 'bg-indigo-100 text-indigo-800' : 'bg-indigo-900/60 text-indigo-200'
                                                        : isLight ? 'text-indigo-700 hover:bg-indigo-100' : 'text-indigo-300 hover:bg-indigo-900/50'}`}
                                                    title="Put back the group's tracks that are not on this panel, in group order"
                                                >
                                                    {pendingAdd ? `✓ Adding ${missing} missing` : `+ ${missing} missing`}
                                                </button>
                                            )}
                                            <PickerRowButton
                                                willShow={willShow}
                                                disabled={!isOnPanel && !memberCount}
                                                onClick={toggle}
                                                isLight={isLight}
                                                tourId={`browser-track-picker-group-toggle-${group.id}`}
                                            />
                                        </div>
                                        <p className={`text-[11px] mt-0.5 truncate ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                            {memberCount} track{memberCount === 1 ? '' : 's'}
                                            {' · '}{group.layout === 'joined' ? 'one joined row' : 'separate rows'}
                                            {typeCounts.size ? ` · ${[...typeCounts.entries()].map(([type, n]) => `${n} ${type}`).join(', ')}` : ''}
                                            {isOnPanel && missing > 0 ? ` · ${missing} not on this panel` : ''}
                                        </p>
                                    </div>
                                )
                            })}
                            {availableGroups.length > 0 && availableTracks.length > 0 && (
                                <div className={`px-1 pt-2 text-[10px] font-semibold uppercase tracking-wide ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>Tracks</div>
                            )}
                            {availableTracks.length === 0 ? (
                                <div className={`text-center py-10 text-sm ${isLight ? 'text-gray-400' : 'text-gray-500'}`}>
                                    <p>Open <strong>Track Manager</strong> → click <strong>Add Track</strong> → register your data files.</p>
                                </div>
                            ) : availableTracks.map((registeredTrack) => {
                                // The track on its own; a group's copy of it is the group's.
                                const addedTrack = customTracks.find((ct) => !ct.group && (
                                    String(ct.registryTrackId || '') === String(registeredTrack.id || '')
                                    || (
                                        String(ct.path || '') === String(registeredTrack.path || '')
                                        && String(ct.type || 'bigwig') === String(registeredTrack.type || 'bigwig')
                                    )
                                ))
                                const alreadyAdded = Boolean(addedTrack)
                                const pickerTrackId = String(registeredTrack.id || '')
                                const willShow = alreadyAdded
                                    ? !pendingPickerRemovals.includes(pickerTrackId)
                                    : selectedTrackPickerIds.includes(pickerTrackId)
                                const toggle = () => togglePickerChange(pickerTrackId, alreadyAdded)
                                const typeColor = {
                                    bigwig: '#3b82f6', vcf: '#f59e0b', bed: '#10b981', bigbed: '#059669', gff: '#0891b2',
                                    splice_junctions: '#8b5cf6', bam: '#ef4444', long_reads: '#ec4899',
                                }[registeredTrack.type] || '#64748b'
                                return (
                                    <div
                                        key={registeredTrack.id}
                                        data-tour-id={`browser-track-picker-row-${registeredTrack.id}`}
                                        data-tutorial-picker-track={registeredTrack.label || ''}
                                        // On the panel, or will be once applied. A tutorial step that asks the
                                        // reader to choose several rows reads this to leave alone the ones they
                                        // have already done — without it, pressing Next after choosing two of
                                        // three unchose those two on its way past.
                                        data-tutorial-engaged={willShow ? 'true' : 'false'}
                                        aria-pressed={willShow}
                                        onClick={toggle}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() }
                                        }}
                                        role="button"
                                        tabIndex={0}
                                        className={pickerRowClass(willShow, isLight)}
                                    >
                                        <div className="flex items-center gap-2">
                                            <span
                                                className="text-[10px] font-semibold px-1.5 py-0.5 rounded shrink-0"
                                                style={{ backgroundColor: typeColor + '22', color: typeColor, border: `1px solid ${typeColor}44` }}
                                            >
                                                {registeredTrack.type}
                                            </span>
                                            <span className={`text-sm font-medium flex-1 min-w-0 truncate ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>
                                                {registeredTrack.label}
                                            </span>
                                            <PickerRowButton willShow={willShow} onClick={toggle} isLight={isLight} />
                                        </div>
                                        <p className={`text-[11px] font-mono mt-0.5 truncate ${isLight ? 'text-gray-400' : 'text-gray-500'}`}>
                                            {registeredTrack.path}
                                        </p>
                                    </div>
                                )
                            })}
                        </div>
                        {/* Footer: nothing changes until Apply. */}
                        <div className={`px-5 py-3 border-t flex items-center gap-2 flex-none ${isLight ? 'border-gray-100 bg-gray-50' : 'border-gray-800 bg-gray-900/50'}`}>
                            <span data-tour-id="browser-track-picker-summary" className={`text-xs mr-auto ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                {[
                                    selectedTrackPickerIds.length ? `${selectedTrackPickerIds.length} to add` : '',
                                    pendingPickerRemovals.length ? `${pendingPickerRemovals.length} to remove` : '',
                                ].filter(Boolean).join(' · ') || 'No changes'}
                            </span>
                            <button
                                data-tour-id="browser-track-picker-close"
                                onClick={closeTrackPicker}
                                className={`px-3 py-1.5 rounded-lg text-xs font-medium border ${isLight ? 'border-gray-300 text-gray-700 hover:bg-gray-100' : 'border-gray-600 text-gray-300 hover:bg-gray-800'}`}
                            >Cancel</button>
                            <button
                                data-tour-id="browser-track-picker-add"
                                onClick={applyTrackPickerChanges}
                                disabled={!pickerHasChanges}
                                className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                                Apply
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {effectiveToolbarPosition === 'top' && toolbar}

            {/* Selected Gene Info Bar (Top) */}
            {effectiveFocusBarPosition === 'top' && (selectedGeneInfoBar || selectedLocationInfoBar)}

            {/* Canvas container. It has no overflow of its own — note that
                `overflow-x-hidden` alone would silently promote overflow-y back to
                `auto` and re-create the inner scrollbar. */}
            <div
                ref={containerRef}
                // Marks the surface that owns its own axis-locked drag, so the
                // view-level drag-to-scroll fallback stands down here.
                data-browser-canvas-surface="true"
                data-focus-panel-key={screenshotTargetId || genome}
                className="flex-grow relative overflow-visible outline-none focus-visible:ring-2 focus-visible:ring-blue-500/70"
                style={{
                    cursor: (isBoxSelectMode || isSelectingRect) ? 'crosshair' : (isDragging ? 'grabbing' : 'grab'),
                    backgroundColor: colors.bg
                }}
                // Focusable so keyboard navigation is scoped to the panel the
                // user is actually on, and reachable by Tab.
                tabIndex={0}
                role="group"
                aria-label={`${genomePillLabel || label || 'Genome'} browser${selectedChrom ? `, ${selectedChrom}` : ''}`}
                aria-describedby={keyboardHintId}
                onKeyDown={handleKeyDown}
                onMouseDown={handleMouseDown}
                onMouseMove={isDragging ? undefined : handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleContainerMouseLeave}
            >
                <p id={keyboardHintId} className="sr-only">{keyboardHintText}</p>

                <canvas
                    ref={canvasRef}
                    onClick={handleCanvasClick}
                    // The gutter's labels are painted, so the track under the pointer
                    // names itself through the canvas: a native tooltip, with the same
                    // look and hover delay as every other control in the app.
                    title={sidebarTooltip || undefined}
                    style={{ display: 'block' }}
                />

                {/* Markers over the track gutter, so a tutorial can point at GF, GR and
                    SL. They exist only to be spotlit: the gutter is painted on the canvas
                    and hit-tested by geometry (see drawToggle), so there is no element to
                    anchor on otherwise, and adding real buttons would mean two code paths
                    for the same toggle. `pointer-events-none` keeps every click going to
                    the canvas exactly as before — the tutorial's steps about these are
                    look-only, and turning tracks on and off is taught through the Tracks
                    button in the bar above, which is real DOM. */}
                {/* Only once the tracks have been laid out. Rendered before that it is a
                    sliver at the top of the panel, and anything measuring it — a tutorial
                    card placing itself beside it — lands in the wrong place and then jumps
                    when the real height arrives. */}
                {gutterMarkerHeight > 0 && (
                    <div
                        aria-hidden="true"
                        data-tour-id="browser-track-gutter"
                        className="absolute pointer-events-none"
                        // Down to the foot of the last track rather than the foot of the
                        // canvas: the canvas keeps whatever empty space the panel has, and
                        // a spotlight that took in all of it framed mostly nothing.
                        style={{ left: 0, top: 0, width: LHS_WIDTH, height: gutterMarkerHeight }}
                    />
                )}
                {/* Written out one by one rather than mapped over a list, because the
                    tutorial's anchor test scans this source for literal `data-tour-id`
                    attributes — an id that arrives in a variable is invisible to it, and
                    a renamed anchor would then fail in front of a user instead of in the
                    suite. */}
                {layout.forwardBgHeight > 0 && (
                    <div
                        aria-hidden="true"
                        data-tour-id="browser-track-gf"
                        className="absolute pointer-events-none"
                        style={gutterMarkerStyle(layout.FORWARD_Y, layout.forwardBgHeight)}
                    />
                )}
                {layout.reverseBgHeight > 0 && (
                    <div
                        aria-hidden="true"
                        data-tour-id="browser-track-gr"
                        className="absolute pointer-events-none"
                        style={gutterMarkerStyle(layout.REVERSE_Y, layout.reverseBgHeight)}
                    />
                )}
                {/* The reverse track's band, full width. Nothing points *at* it; it is
                    what a step's card is placed against when the step spotlights the whole
                    track and the card would otherwise land on the genes being described. */}
                {layout.reverseBgHeight > 0 && (
                    <div
                        aria-hidden="true"
                        data-tour-id="browser-track-gr-band"
                        className="absolute pointer-events-none"
                        style={{
                            left: LHS_WIDTH,
                            top: layout.REVERSE_Y,
                            width: Math.max(1, viewWidth - LHS_WIDTH),
                            height: layout.reverseBgHeight,
                        }}
                    />
                )}
                {showSequenceTrack && layout.SEQUENCE_Y >= 0 && (
                    <div
                        aria-hidden="true"
                        data-tour-id="browser-track-sl"
                        className="absolute pointer-events-none"
                        style={gutterMarkerStyle(layout.SEQUENCE_Y, layout.seqBgHeight)}
                    />
                )}

                {/* The gene index note. Positioned against the panel rather than
                    against the genome, so it stays put through a pan or a zoom
                    instead of sliding away with the coordinates it would
                    otherwise be pinned to. The canvas underneath stays live. */}
                {geneIndexOverlayGeometry && (
                    <GeneIndexProgressOverlay
                        status={geneIndexStatus}
                        isLight={isLight}
                        left={LHS_WIDTH}
                        width={Math.max(1, viewWidth - LHS_WIDTH)}
                        top={geneIndexOverlayGeometry.top}
                        height={geneIndexOverlayGeometry.height}
                        onRetry={retryGeneIndex}
                    />
                )}

                {/* Invisible buttons over the canvas-drawn gutter switches, so a tutorial can
                    point at one and a reader can press it. The click goes to the same setter
                    the canvas hit-test uses, so there is still one code path for the control.

                    Gated on a tutorial running rather than on `tutorialRecipeId`: that id is
                    only set for a genome installed from an embedded dataset recipe, and a
                    tutorial running on one of the *bundled* genomes — which is how the Track
                    Manager tutorial reaches the chromosome-1 slice — had no id, so none of
                    these existed and the gutter was unanchored. */}
                {tutorialAnchorsActive && [
                    ['forward', layout.FORWARD_Y + layout.forwardBgHeight / 2, layout.forwardBgHeight > 0],
                    ['reverse', layout.REVERSE_Y + layout.reverseBgHeight / 2, layout.reverseBgHeight > 0],
                    ['sequence', layout.SEQUENCE_Y + layout.seqBgHeight / 2, showSequenceTrack && layout.SEQUENCE_Y >= 0],
                ].filter(([, , visible]) => visible).map(([strand, y]) => (
                    <button key={strand} data-tour-id={{ forward: 'browser-toggle-forward', reverse: 'browser-toggle-reverse', sequence: 'browser-toggle-sequence' }[strand]}
                        aria-label={`Toggle ${strand} track`} aria-pressed={!hiddenStrands[strand]}
                        data-tutorial-engaged={!hiddenStrands[strand] ? 'true' : 'false'}
                        onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()}
                        onClick={(event) => { event.stopPropagation(); setHiddenStrands((prev) => ({ ...prev, [strand]: !prev[strand] })) }}
                        className="absolute rounded-full"
                        style={{ left: LHS_WIDTH - 25, top: y - 12, width: 24, height: 24, background: 'transparent' }} />
                ))}
                {/* The same again for each custom track. Addressed by the track's label rather
                    than by its registry id, which is minted when the track is registered and
                    cannot be written into a portable document. */}
                {tutorialAnchorsActive && Object.entries(layout.customTrackLayouts || {}).map(([trackId, trackLayout]) => {
                    const track = customTracksById.get(trackId)
                    if (!track) return null
                    const y = getCustomTrackToggleY(trackLayout)
                    if (!Number.isFinite(y)) return null
                    return (
                        <button key={trackId}
                            data-tour-id={`browser-toggle-track-${trackId}`}
                            data-tutorial-track-switch={track.label || ''}
                            aria-label={`Toggle ${track.label || 'custom'} track`} aria-pressed={track.visible !== false}
                            data-tutorial-engaged={track.visible !== false ? 'true' : 'false'}
                            onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()}
                            onClick={(event) => {
                                event.stopPropagation()
                                setCustomTracks((prev) => prev.map((entry) => (
                                    entry.id === trackId ? { ...entry, visible: !entry.visible } : entry
                                )))
                            }}
                            className="absolute rounded-full"
                            style={{ left: LHS_WIDTH - 25, top: y - 12, width: 24, height: 24, background: 'transparent' }} />
                    )
                })}

                {customTrackHoverTooltip && (
                    <div
                        className="pointer-events-none fixed z-30 px-2.5 py-1.5 text-[11px] rounded-md shadow-lg"
                        style={{
                            left: customTrackHoverTooltip.x + 12,
                            top: customTrackHoverTooltip.y + 12,
                            backgroundColor: colors.infoBg,
                            color: colors.infoText,
                            border: `1px solid ${isLight ? '#d0d7e2' : '#334155'}`,
                            backdropFilter: 'blur(2px)',
                        }}
                    >
                        {customTrackHoverTooltip.text}
                    </div>
                )}

                {clickedGeneTranscript?.transcript && (
                    <TranscriptInfoPopup
                        popup={clickedGeneTranscript}
                        selectedChrom={selectedChrom}
                        onMouseEnter={() => {
                            transcriptPopupHoverRef.current = true
                            clearTranscriptPopupDismissTimer()
                        }}
                        onMouseLeave={() => {
                            transcriptPopupHoverRef.current = false
                            scheduleTranscriptPopupDismiss(70)
                        }}
                    />
                )}

                {/* Variant info popup (click on adp_detail variant) */}
                {clickedVcfVariant && (() => {
                    const { variant: v, chrom, arrowTargetX, arrowTargetY } = clickedVcfVariant
                    const popupW = 260
                    const arrowSize = 8
                    const gap = 4
                    // Box sits to the left of the feature; flip right only when near left edge
                    const spaceLeft = arrowTargetX - arrowSize - gap
                    const goLeft = spaceLeft >= popupW
                    const popupLeft = goLeft
                        ? arrowTargetX - popupW - arrowSize - gap
                        : arrowTargetX + arrowSize + gap
                    const typeLabel = v.type === 'snv' ? 'SNV' : v.type === 'ins' ? 'insertion' : v.type === 'del' ? 'deletion' : (v.label || 'variant')
                    const pos1 = Number(v.pos).toLocaleString()
                    const displayId = v.id && v.id !== '.' ? v.id : null
                    return (
                        <div
                            className="fixed z-40 rounded-lg shadow-xl text-[12px] leading-relaxed"
                            style={{
                                left: popupLeft,
                                top: arrowTargetY,
                                transform: 'translateY(-50%)',
                                width: popupW,
                                backgroundColor: 'rgba(17, 24, 39, 0.97)',
                                color: '#f1f5f9',
                                padding: '10px 14px',
                                border: '1px solid rgba(255,255,255,0.1)',
                                pointerEvents: 'none',
                                overflowWrap: 'break-word',
                                wordBreak: 'break-all',
                            }}
                        >
                            {/* Arrow pointing right toward the feature (on right side when goLeft, left side when flipped) */}
                            <div style={{
                                position: 'absolute',
                                top: '50%',
                                transform: 'translateY(-50%)',
                                [goLeft ? 'right' : 'left']: -arrowSize,
                                width: 0,
                                height: 0,
                                borderTop: `${arrowSize}px solid transparent`,
                                borderBottom: `${arrowSize}px solid transparent`,
                                [goLeft ? 'borderLeft' : 'borderRight']: `${arrowSize}px solid rgba(17,24,39,0.97)`,
                            }} />
                            <div>Variant <span style={{ fontWeight: 700 }}>{displayId || `${chrom}:${pos1}`}</span></div>
                            <div><span style={{ fontWeight: 700 }}>{typeLabel.toUpperCase()}</span>&nbsp;&nbsp;{chrom}:{pos1}</div>
                            <div>Alleles <span style={{ fontWeight: 700 }}>{v.ref} {v.alt}</span></div>
                        </div>
                    )
                })()}

                {/* Splice junction info popup (click on arc) */}
                {clickedSpliceJunction && (() => {
                    const { junction: j, popupX, popupY } = clickedSpliceJunction
                    const popupW = 300
                    const arrowSize = 8
                    const gap = 4
                    const popupTop = Math.max(8, popupY - arrowSize - gap)
                    const support = Number(j?.n_total ?? j?.reads ?? 0)
                    const canonicalLabel = j?.canonical === true ? 'Canonical' : 'Non-canonical'
                    const annotationLabel = j?.annotated === true ? 'Annotated' : 'Novel'
                    const strandRaw = String(j?.strand || '.')
                    const strandLabel = strandRaw === '+'
                        ? 'Forward'
                        : strandRaw === '-'
                            ? 'Reverse'
                            : 'Unknown'
                    const motifLabel = formatSpliceMotifForDisplay(j?.motif, strandRaw)
                    const span = Math.max(0, (Number(j?.end) || 0) - (Number(j?.start) || 0))
                    return (
                        <div
                            className="fixed z-40 rounded-lg shadow-xl text-[12px] leading-relaxed"
                            style={{
                                left: popupX,
                                top: popupTop,
                                transform: 'translate(-50%, -100%)',
                                width: popupW,
                                backgroundColor: 'rgba(17, 24, 39, 0.97)',
                                color: '#f1f5f9',
                                padding: '10px 14px',
                                border: '1px solid rgba(255,255,255,0.1)',
                                pointerEvents: 'none',
                                overflowWrap: 'break-word',
                                wordBreak: 'break-word',
                            }}
                        >
                            <div style={{
                                position: 'absolute',
                                bottom: -arrowSize,
                                left: '50%',
                                transform: 'translateX(-50%)',
                                width: 0,
                                height: 0,
                                borderTop: `${arrowSize}px solid rgba(17,24,39,0.97)`,
                                borderLeft: `${arrowSize}px solid transparent`,
                                borderRight: `${arrowSize}px solid transparent`,
                            }} />
                            <div>Junction <span style={{ fontWeight: 700 }}>{chromLabel(selectedChrom)}:{formatCoord(j?.start)}-{formatCoord(j?.end)}</span></div>
                            <div>Support <span style={{ fontWeight: 700 }}>{support.toLocaleString()}</span></div>
                            <div>Class <span style={{ fontWeight: 700 }}>{canonicalLabel}</span></div>
                            <div>Status <span style={{ fontWeight: 700 }}>{annotationLabel}</span></div>
                            <div>Motif <span style={{ fontWeight: 700 }}>{motifLabel}</span></div>
                            <div>Strand <span style={{ fontWeight: 700 }}>{strandLabel}</span></div>
                            <div>Intron span <span style={{ fontWeight: 700 }}>{span.toLocaleString()} bp</span></div>
                        </div>
                    )
                })()}

                {/* BigBed feature info popup (click on detail feature) */}
                {clickedBigBedFeature && (() => {
                    const { feature: f, popupX, popupY } = clickedBigBedFeature
                    const popupW = 320
                    const arrowSize = 8
                    const gap = 4
                    const popupTop = Math.max(8, popupY - arrowSize - gap)
                    const start = Number(f?.start)
                    const end = Number(f?.end)
                    const strandRaw = String(f?.strand || '.')
                    const strandLabel = strandRaw === '+'
                        ? 'Forward'
                        : strandRaw === '-'
                            ? 'Reverse'
                            : 'Unknown'
                    const scoreNum = Number(f?.score)
                    // A file with no score (GFF's ".") is reported as parsed to "0"; say so
                    // rather than claim a score of zero.
                    const scoreLabel = f?.has_score === false
                        ? '—'
                        : Number.isFinite(scoreNum)
                            ? scoreNum.toLocaleString(undefined, { maximumFractionDigits: 2 })
                            : (String(f?.score || '').trim() || '—')
                    // Named where the file names them (a BigBed's autoSql, a GFF's type,
                    // source and attributes); otherwise listed together, as before.
                    const rawExtraValues = Array.isArray(f?.extra_fields) ? f.extra_fields : []
                    const rawExtraNames = Array.isArray(f?.extra_field_names) ? f.extra_field_names : []
                    const namedExtras = rawExtraNames.length === rawExtraValues.length
                        ? rawExtraValues
                            .map((value, i) => ({ name: String(rawExtraNames[i] || '').trim(), value: String(value || '').trim() }))
                            .filter((row) => row.value && row.name && !/^extra_\d+$/.test(row.name))
                        : []
                    const extraFields = rawExtraValues
                        .map((v) => String(v || '').trim())
                        .filter(Boolean)
                        .filter((v) => !namedExtras.some((row) => row.value === v))
                    const featureName = String(f?.name || '').trim()
                    // Features are held in the browser's frame, [first base, last base + 1).
                    const spanLabel = Number.isFinite(start) && Number.isFinite(end) && end > start
                        ? `${formatCoord(start)}-${formatCoord(end - 1)}`
                        : '—'
                    const exonBlocks = Array.isArray(f?._exon_blocks)
                        ? f._exon_blocks
                        : (Array.isArray(f?.exon_blocks) ? f.exon_blocks : [])
                    const cdsBlocks = Array.isArray(f?._cds_blocks)
                        ? f._cds_blocks
                        : (Array.isArray(f?.cds_blocks) ? f.cds_blocks : [])
                    const isTranscriptModel = (
                        (String(f?._render_kind || f?.render_kind || '').toLowerCase() === 'transcript')
                        && ((f?._structure_valid === true) || (f?.structure_valid === true) || exonBlocks.length > 0)
                    )
                    const cdsSpanStart = cdsBlocks.length > 0
                        ? Math.min(...cdsBlocks.map((block) => Number(block?.start)).filter((v) => Number.isFinite(v)))
                        : null
                    const cdsSpanEnd = cdsBlocks.length > 0
                        ? Math.max(...cdsBlocks.map((block) => Number(block?.end)).filter((v) => Number.isFinite(v)))
                        : null
                    return (
                        <div
                            className="fixed z-40 rounded-lg shadow-xl text-[12px] leading-relaxed"
                            style={{
                                left: popupX,
                                top: popupTop,
                                transform: 'translate(-50%, -100%)',
                                width: popupW,
                                backgroundColor: 'rgba(17, 24, 39, 0.97)',
                                color: '#f1f5f9',
                                padding: '10px 14px',
                                border: '1px solid rgba(255,255,255,0.1)',
                                pointerEvents: 'none',
                                overflowWrap: 'break-word',
                                wordBreak: 'break-word',
                            }}
                        >
                            <div style={{
                                position: 'absolute',
                                bottom: -arrowSize,
                                left: '50%',
                                transform: 'translateX(-50%)',
                                width: 0,
                                height: 0,
                                borderTop: `${arrowSize}px solid rgba(17,24,39,0.97)`,
                                borderLeft: `${arrowSize}px solid transparent`,
                                borderRight: `${arrowSize}px solid transparent`,
                            }} />
                            <div>Feature <span style={{ fontWeight: 700 }}>{featureName || `${chromLabel(selectedChrom)}:${spanLabel}`}</span></div>
                            <div>Region <span style={{ fontWeight: 700 }}>{chromLabel(selectedChrom)}:{spanLabel}</span></div>
                            <div>Score <span style={{ fontWeight: 700 }}>{scoreLabel}</span></div>
                            <div>Strand <span style={{ fontWeight: 700 }}>{strandLabel}</span></div>
                            <div>Model <span style={{ fontWeight: 700 }}>{isTranscriptModel ? 'Transcript-like' : 'Interval'}</span></div>
                            {f?._thick && (
                                <div>Thick <span style={{ fontWeight: 700 }}>
                                    {f._thick.end > f._thick.start
                                        ? `${formatCoord(f._thick.start)}-${formatCoord(f._thick.end - 1)}`
                                        : 'None (all thin)'}
                                </span></div>
                            )}
                            {isTranscriptModel && (
                                <>
                                    <div>Exons <span style={{ fontWeight: 700 }}>{exonBlocks.length}</span></div>
                                    <div>CDS <span style={{ fontWeight: 700 }}>
                                        {(Number.isFinite(cdsSpanStart) && Number.isFinite(cdsSpanEnd))
                                            ? `${formatCoord(cdsSpanStart)}-${formatCoord(cdsSpanEnd - 1)} (${cdsBlocks.length} block${cdsBlocks.length === 1 ? '' : 's'})`
                                            : 'None'}
                                    </span></div>
                                </>
                            )}
                            {namedExtras.map((row) => (
                                <div key={row.name} style={{ overflowWrap: 'anywhere' }}>
                                    {row.name} <span style={{ fontWeight: 700 }}>{row.value}</span>
                                </div>
                            ))}
                            {extraFields.length > 0 && (
                                <div style={{ overflowWrap: 'anywhere' }}>Extra <span style={{ fontWeight: 700 }}>{extraFields.join(' | ')}</span></div>
                            )}
                        </div>
                    )
                })()}

                {/* Sequence base info popup (click on sequence track base) */}
                {clickedSeqBase && (() => {
                    const { bp, base, popupX, popupY } = clickedSeqBase
                    const pos1 = bp.toLocaleString()
                    const baseColor = getBaseColor(base, colors)
                    const popupW = 'max-content'
                    return (
                        <div
                            className="fixed z-40 rounded-lg shadow-xl text-[12px]"
                            style={{
                                left: popupX,
                                top: popupY,
                                transform: 'translateX(-50%)',
                                backgroundColor: 'rgba(17, 24, 39, 0.97)',
                                color: '#f1f5f9',
                                padding: '5px 10px',
                                border: '1px solid rgba(255,255,255,0.1)',
                                pointerEvents: 'none',
                                whiteSpace: 'nowrap',
                                width: popupW,
                            }}
                        >
                            {chromLabel(selectedChrom)}:{pos1}&nbsp;&nbsp;<span style={{ fontWeight: 700, color: baseColor }}>{base.toUpperCase()}</span>
                        </div>
                    )
                })()}

                {/* Beta-style transcript expansion controls */}
                {transcriptFooterOverlay.controls.map(control => {
                    const controlBaseColor = control.isDimmed
                        ? (isLight ? '#94a3b8' : '#64748b')
                        : panelPillColor
                    const controlTextColor = control.isDimmed
                        ? (isLight ? '#1f2937' : '#e5e7eb')
                        : colors.pillText
                    return (
                        <Fragment key={control.id}>
                        {control.isExpandedControl && control.geneLabel && (
                            <span
                                aria-hidden="true"
                                className="absolute font-sans whitespace-nowrap pointer-events-none"
                                style={{
                                    left: control.x,
                                    top: control.geneLabelY - EXPANDED_FOOTER_LABEL_TOP_OFFSET,
                                    minHeight: 11,
                                    padding: '0 2px',
                                    borderRadius: 2,
                                    backgroundColor: control.trackBackground || colors.bg,
                                    color: colors.geneLabelText,
                                    fontSize: '11px',
                                    lineHeight: '11px',
                                    zIndex: 12,
                                }}
                            >
                                {control.geneLabel}
                            </span>
                        )}
                        {control.hasPrimary && (
                        <button
                            // DOM over the canvas, so a tutorial can point at it without
                            // the marker-div trick the track gutter needs. `engaged` is
                            // what lets an arrival set the gene's transcripts rather than
                            // toggle them: the pill shows a collapse action exactly when
                            // the gene is already expanded.
                            data-tour-id={`browser-gene-transcripts-${control.id}`}
                            data-tutorial-engaged={control.action === 'collapse' ? 'true' : 'false'}
                            onClick={(e) => {
                                e.stopPropagation()
                                const expand = control.action !== 'collapse'
                                // The focused gene's expand state belongs to the
                                // drawer, so this pill drives that instead of the
                                // panel-local map — one state, two controls.
                                if (control.isFocused) {
                                    onFocusTranscriptViewChangeRef.current?.({ expanded: expand })
                                } else {
                                    setExpandedGenes(prev => ({
                                        ...prev,
                                        [control.id]: expand ? control.totalTranscripts : 1,
                                    }))
                                }
                                if (expand) {
                                    requestTranscriptPillFocus(control.id, {
                                        limit: control.totalTranscripts,
                                        waitForTranscripts: !transcriptCache[control.id],
                                        // Park the first transcript at the top of the
                                        // window: with a long set, chasing the bottom
                                        // scrolls the gene's start out of sight.
                                        preferBottomVisible: false,
                                        // Match focused-gene navigation: centre the gene and
                                        // size the genomic window around its displayed bounds.
                                        preserveHorizontalViewport: false,
                                    })
                                    fetchTranscripts(control.id)
                                } else {
                                    requestTranscriptPillFocus(control.id, {
                                        limit: 1,
                                        preserveHorizontalViewport: true,
                                    })
                                }
                            }}
                            title={control.title}
                            aria-label={control.title}
                            className="absolute p-0 m-0 border-0 font-semibold transition-opacity hover:opacity-85"
                            style={{
                                left: control.controlX,
                                top: control.y,
                                width: control.width,
                                minWidth: control.width,
                                height: TRANSCRIPT_FOOTER_CONTROL_HEIGHT,
                                minHeight: TRANSCRIPT_FOOTER_CONTROL_HEIGHT,
                                borderRadius: 1,
                                backgroundColor: controlBaseColor,
                                color: controlTextColor,
                                fontSize: '10px',
                                lineHeight: '1',
                                display: 'inline-flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                cursor: 'pointer',
                                zIndex: 10,
                                opacity: control.isDimmed ? 0.8 : 1,
                            }}
                        >
                            {control.label}
                        </button>
                        )}

                        {/* Hidden transcripts survive collapsing and unfocusing, so
                            the way back has to live on the gene itself. */}
                        {control.hiddenCount > 0 && (
                            <button
                                // The way back, and the only thing on screen saying a
                                // transcript is missing at all — so a tutorial has to be
                                // able to point at it.
                                data-tour-id={`browser-gene-hidden-transcripts-${control.id}`}
                                onClick={(e) => {
                                    e.stopPropagation()
                                    onGeneTranscriptViewChangeRef.current?.(control.id, { hidden: [], ghostId: null })
                                }}
                                title={`Show ${control.hiddenCount} hidden transcript${control.hiddenCount === 1 ? '' : 's'}`}
                                aria-label={`Show ${control.hiddenCount} hidden transcript${control.hiddenCount === 1 ? '' : 's'}`}
                                className="absolute p-0 m-0 border-0 font-semibold transition-opacity hover:opacity-85"
                                style={{
                                    left: control.controlX + (control.hasPrimary ? control.width + CONTROL_GAP_PX : 0),
                                    top: control.y,
                                    width: control.restoreWidth,
                                    minWidth: control.restoreWidth,
                                    height: TRANSCRIPT_FOOTER_CONTROL_HEIGHT,
                                    minHeight: TRANSCRIPT_FOOTER_CONTROL_HEIGHT,
                                    borderRadius: 1,
                                    backgroundColor: 'transparent',
                                    border: `1px solid ${controlBaseColor}`,
                                    color: controlBaseColor,
                                    fontSize: '10px',
                                    lineHeight: '1',
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    cursor: 'pointer',
                                    zIndex: 10,
                                    opacity: control.isDimmed ? 0.8 : 1,
                                }}
                            >
                                {control.restoreLabel}
                            </button>
                        )}
                        </Fragment>
                    )
                })}

                {/* One bubble per gene the user has written about. Above the
                    footer pills in the stack, because it sits at the head of the
                    gene where nothing else competes for the space. */}
                {geneNoteOverlay.bubbles.map((bubble) => (
                    <button
                        key={`note-${bubble.id}`}
                        data-tour-id={`browser-gene-note-${bubble.id}`}
                        type="button"
                        onClick={(e) => {
                            // Without this the canvas click handler runs too and
                            // toggles the very gene this is trying to open.
                            e.stopPropagation()
                            setSelectedGene(bubble.gene)
                            onOpenGeneNotesRef.current?.(String(bubble.gene.id))
                        }}
                        title={`${bubble.count} note${bubble.count === 1 ? '' : 's'} — open notes`}
                        aria-label={`Open ${bubble.count} note${bubble.count === 1 ? '' : 's'} on ${bubble.gene.name || bubble.gene.id}`}
                        className="absolute p-0 m-0 border-0 bg-transparent transition-opacity hover:opacity-85"
                        style={{
                            left: bubble.x,
                            top: bubble.y,
                            width: NOTE_BUBBLE_SIZE,
                            height: NOTE_BUBBLE_SIZE,
                            color: bubble.isDimmed ? (isLight ? '#94a3b8' : '#64748b') : panelPillColor,
                            cursor: 'pointer',
                            zIndex: 11,
                            opacity: bubble.isDimmed ? 0.8 : 1,
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                        }}
                    >
                        {/* Filled, and its rules knocked out in the track's own
                            background, so the mark reads as writing on a bubble
                            rather than a solid blob at this size. */}
                        <NoteGlyph size={NOTE_BUBBLE_SIZE} filled knockout={colors.bg} />
                    </button>
                ))}

                {/* Loading indicator */}
                {loadingGenes && (
                    <div
                        className="absolute top-2 right-2 text-xs px-2 py-1 rounded"
                        style={{
                            backgroundColor: panelPillColor + '40',
                            color: panelPillColor,
                        }}
                    >
                        Loading...
                    </div>
                )}
            </div>

            {/* Selected Gene Info Bar (Bottom) */}
            {effectiveFocusBarPosition === 'bottom' && (selectedGeneInfoBar || selectedLocationInfoBar)}

            {/* Toolbar bottom */}
            {effectiveToolbarPosition === 'bottom' && (
                <div style={{ borderTop: `1px solid ${isLight ? '#dee2e6' : '#373a40'}` }}>
                    {toolbar}
                </div>
            )}

            {showInitialLoadingOverlay && (
                <div
                    className="absolute inset-0 z-40 flex items-center justify-center"
                    style={{
                        backgroundColor: isLight ? 'rgba(248, 250, 252, 0.82)' : 'rgba(15, 23, 42, 0.78)',
                        backdropFilter: 'blur(2px)',
                    }}
                >
                    <div
                        className={`rounded-xl border px-5 py-4 shadow-lg ${isLight ? 'bg-white border-gray-200 text-gray-900' : 'bg-gray-900/95 border-gray-700 text-gray-100'}`}
                        style={{ minWidth: 280 }}
                    >
                        <div className="flex items-center gap-3">
                            <div
                                className={`h-7 w-7 animate-spin rounded-full border-4 border-t-transparent ${isLight ? 'border-sky-500' : 'border-sky-400'}`}
                                aria-hidden="true"
                            />
                            <div>
                                <div className="text-sm font-semibold">Loading Genome Browser</div>
                                <div className={`text-xs ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                    Preparing regions, controls, and annotation tracks...
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}

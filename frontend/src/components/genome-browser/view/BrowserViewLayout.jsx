// The rendered Genome Browser view: global controls, focus drawers and rails,
// the panels (each a GenomeBrowser), the scroll rail and screenshot overlay.
// Returned by GenomeBrowserView (a plain call, not a separate component).
import { browserControlKey } from '../../../achievements/browserControls.js'
import { trackAchievement } from '../../../achievements/tracker.js'
import { DEFAULT_NOTE_SORT_MODE } from '../../../utils/geneNotes.js'
import { getGenomeKey, trackAssemblyKey } from '../../../utils/genomeIdentity.js'
import { LOCKED_ICON_PATH, UNLOCKED_ICON_PATH } from '../../../utils/lockIcons.js'
import AssemblyInfoDrawer from '../../AssemblyInfoDrawer'
import BrowserScrollRail from '../../BrowserScrollRail'
import FocusGeneDrawer, { FOCUS_DRAWER_DETAIL_WIDTH, FOCUS_DRAWER_RAIL_WIDTH, FOCUS_DRAWER_WIDTH } from '../../FocusGeneDrawer'
import FocusLocationDrawer, { LOCATION_DRAWER_DETAIL_WIDTH } from '../../FocusLocationDrawer'
import GenomeWheel from '../../GenomeWheel'
import ScreenshotExportModal from '../../ScreenshotExportModal'
import ScreenshotSelectionOverlay from '../../ScreenshotSelectionOverlay'
import GenomeBrowser from '../GenomeBrowser'
import { EMPTY_NOTE_COUNTS, EMPTY_NOTE_LIST, EMPTY_TRACK_LIST } from './browserViewModel.js'
import { IndexPreparingNotice } from './IndexPreparingNotice'

export function renderBrowserView(ctx) {
    const {
        activePinPanelKey,
        adaptivePanelHeight,
        alignPanelToTop,
        alignmentOverlay,
        anyFocusedGene,
        assemblyDrawerAlignByPanel,
        assemblyDrawerOpenByPanel,
        assemblyInfoByPanel,
        availableGroupsByPanel,
        availableTracksByPanel,
        biotypeFilter,
        browserActionButtonStyle,
        browserReadyState,
        browserTracksRequest,
        browsingControls,
        clearFocusEpoch,
        clearPendingLinkApply,
        closeAssemblyDrawer,
        compressMode,
        config,
        controlsFollowScroll,
        cyclePreview,
        defaultScreenshotDir,
        detailListShiftByPanel,
        detailTranscriptByPanel,
        effectiveLockPan,
        effectiveLockZoom,
        externalFocusLocationsByGenome,
        fallbackBrowseRoot,
        farPanelKeys,
        fillSinglePanelHeight,
        flattenMode,
        focusDrawerAlignByPanel,
        focusDrawerEntries,
        focusDrawerInsetFor,
        focusDrawerPinOffset,
        focusDrawerStickyInset,
        focusTranscriptViews,
        forceTracksVisibility,
        geneTranscriptViews,
        globalTracksState,
        growingPanelStyle,
        handleClearFocusedGenes,
        handleClearPanelFocus,
        handleCyclePromote,
        handleDetailTranscriptChange,
        handleFocusTranscriptViewChange,
        handleGlobalTracksToggle,
        handleLinkGene,
        handleLinkRegion,
        handleLocationDetailChange,
        handleLocationDrawerFit,
        handleLocationFocusGene,
        handleLocationGeneHiddenToggle,
        handleLocationNoteCreate,
        handleLocationNoteDelete,
        handleLocationNotesPanelToggle,
        handleManualBrowserNavigate,
        handleNoteCreate,
        handleNoteDelete,
        handleNotesPanelToggle,
        handleOpenNoteChange,
        handleScreenshotModalClose,
        handleScreenshotSave,
        hasPanels,
        heldPanelPositions,
        hiddenBiotypeClasses,
        hideInactiveMode,
        holdFarPanels,
        incomingGene,
        incomingGeneError,
        isActive,
        isFeatureHiddenByClass,
        isFocusDrawerOpen,
        isLight,
        isLocationDrawerOpen,
        isOverlayActive,
        linkModelRef,
        linkedPanelKeys,
        linkingGene,
        linkingRegion,
        listedGenomes,
        locationDetailByPanel,
        locationDrawerFitByPanel,
        locationFeaturesByPanel,
        locationHiddenGenesByPanel,
        locationNoteSortByPanel,
        locationNotesByPanel,
        locationNotesPanelOpenByPanel,
        locationOpenNoteIdByPanel,
        lockPan,
        lockZoom,
        navigateGenes,
        noteCountsByPanel,
        noteSortByPanel,
        noteStore,
        notesByPanel,
        notesGenomeKeyFor,
        notesPanelOpenByPanel,
        onClearAlignmentOverlay,
        onPromoteGenome,
        onScreenshotModeChange,
        openNoteIdByPanel,
        panelCallbacks,
        panelClearEpochs,
        panelContentHeights,
        panelCount,
        panelMinHeight,
        panelPositions,
        panelSpecies,
        panels,
        panelsBottomSpacer,
        refReloadKey,
        refreshRegisteredTracks,
        resolveGenomeColor,
        retryGenomeIndex,
        screenshotMode,
        screenshotOverlayRootRef,
        screenshotPanelsRef,
        screenshotTargets,
        screenshotToggleButtonRef,
        scrollRailStops,
        selectedLocations,
        selectedScreenshotTarget,
        sessionActive,
        sessionHandlerFor,
        sessionReady,
        sessionTracksByGenome,
        setAdaptivePanelHeightOverride,
        setBiotypeFilter,
        setCompressMode,
        setControlsFollowScroll,
        setCyclePreview,
        setDetailTranscriptByPanel,
        setFlattenMode,
        setFocusDrawerOpenByPanel,
        setHideInactiveMode,
        setIncomingGeneError,
        setLinkedPanelKeys,
        setLocationDetailByPanel,
        setLocationDrawerOpenByPanel,
        setLocationFeaturesEpoch,
        setLocationNoteSortByPanel,
        setLocationNotesPanelOpenByPanel,
        setLocationOpenNoteIdByPanel,
        setLockPan,
        setLockZoom,
        setNoteSortByPanel,
        setNotesPanelOpenByPanel,
        setPanelPositions,
        setSelectedScreenshotTarget,
        sharedCanvasHeight,
        syncSourcePanelKeyRef,
        tgtReloadKey,
        theme,
        tutorialRunning,
        useAdaptivePanelHeight,
    } = ctx
    return (
<div
            ref={screenshotOverlayRootRef}
            className="relative w-full flex flex-col"
            style={fillSinglePanelHeight ? { minHeight: '100%' } : undefined}
        >
            {isOverlayActive && (
                <div className={`flex-none w-full px-4 py-2 flex items-center justify-between shadow-sm border-b z-10 ${isLight ? 'bg-indigo-50 border-indigo-200 text-indigo-900' : 'bg-indigo-900/40 border-indigo-800/50 text-indigo-100'}`}>
                    <div className="flex items-center gap-2">
                        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>
                        <span className="text-sm font-medium">Linked alignment active</span>
                        <span className="text-xs ml-2 opacity-80">Regions are synchronised based on the pairwise alignment. Gaps are shown in sequence and features.</span>
                    </div>
                    <button
                        onClick={onClearAlignmentOverlay}
                        className={`text-xs px-3 py-1.5 rounded-md font-medium transition-colors ${isLight ? 'bg-indigo-200 hover:bg-indigo-300 text-indigo-900' : 'bg-indigo-800 hover:bg-indigo-700 text-indigo-100'}`}
                    >
                        Exit linked alignment
                    </button>
                </div>
            )}

            {/* `data-tutorial-occluder` while it follows the scroll: the bar then floats
                over the panels instead of scrolling with them, and a tutorial spotlight on
                whatever slides underneath has to stop at its edge rather than paint over
                the buttons the step is not talking about. */}
            <div
                data-browser-controls="true"
                data-browser-global-controls="true"
                data-tour-id="browser-global-controls"
                // Control freak: which controls have ever been used. One listener for the
                // whole bar rather than one per button; see achievements/browserControls.js.
                onClickCapture={(event) => {
                    const key = browserControlKey(event.target)
                    if (key) trackAchievement('browser.control', key)
                }}
                data-tutorial-occluder={controlsFollowScroll ? 'true' : undefined}
                className="flex items-center justify-between px-4 py-2 border-b flex-none"
                style={{
                    backgroundColor: isLight ? '#f1f3f5' : '#1E2938',
                    borderColor: isLight ? '#dee2e6' : '#373a40',
                    // Pulled up by the scroller's own padding, so the row comes to
                    // rest against the app's top bar rather than a padding below it.
                    ...(controlsFollowScroll
                        ? { position: 'sticky', top: -Math.max(0, focusDrawerStickyInset), zIndex: 30 }
                        : null),
                }}
            >
                <div className="flex items-center gap-2">
                    {hasPanels && (
                        <>
                            <button
                                data-tour-id="browser-tracks-toggle"
                                onClick={() => {
                                    if (globalTracksState !== 'off') trackAchievement('browser.tracksAway')
                                    handleGlobalTracksToggle()
                                }}
                                className="flex-shrink-0 flex items-center gap-1.5 text-xs px-2.5 py-1 rounded transition-colors hover:bg-gray-100 dark:hover:bg-[#373a40]"
                                style={{
                                    backgroundColor: isLight ? '#ffffff' : '#1E2938',
                                    color: isLight ? '#4b5563' : '#9ca3af',
                                    border: `1px solid ${isLight ? '#d1d5db' : '#4b5563'}`,
                                }}
                                title={globalTracksState === 'off' ? 'Show all tracks' : 'Hide all tracks'}
                            >
                                <svg width="14" height="26" viewBox="0 0 14 26" fill="none">
                                    <rect
                                        x="0" y="0" width="14" height="26" rx="7"
                                        fill={globalTracksState === 'off' ? (isLight ? '#ced4da' : '#373a40') : (globalTracksState === 'mixed' ? (isLight ? '#adb5bd' : '#5c5f66') : '#3366cc')}
                                        className="transition-colors duration-200"
                                    />
                                    <circle
                                        cx="7"
                                        cy={globalTracksState === 'off' ? '19' : (globalTracksState === 'mixed' ? '13' : '7')}
                                        r="5"
                                        fill="#ffffff"
                                        className="transition-all duration-200"
                                    />
                                </svg>
                                Tracks
                            </button>

                            <button
                                type="button"
                                data-browser-control="browser-adaptive"
                                onClick={() => setAdaptivePanelHeightOverride(!adaptivePanelHeight)}
                                className="flex-shrink-0 self-stretch flex items-center gap-1.5 text-xs px-2.5 py-1 rounded transition-colors"
                                style={browserActionButtonStyle(true, useAdaptivePanelHeight)}
                                title="Let each browser shrink to exactly its track content instead of keeping a uniform band height"
                            >
                                Adaptive
                            </button>

                            <button
                                onClick={() => {
                                    if (!hideInactiveMode) trackAchievement('browser.tracksAway')
                                    setHideInactiveMode((prev) => !prev)
                                }}
                                data-tour-id="browser-hide-inactive"
                                data-tutorial-engaged={hideInactiveMode ? 'true' : 'false'}
                                className="flex-shrink-0 self-stretch flex items-center gap-1.5 text-xs px-2.5 py-1 rounded transition-colors"
                                style={browserActionButtonStyle(true, hideInactiveMode)}
                                title={hideInactiveMode
                                    ? 'Show inactive tracks in browser'
                                    : 'Hide inactive tracks from view as they are turned off'}
                            >
                                Hide
                            </button>

                            <button
                                data-tour-id="browser-detail"
                                data-tutorial-engaged={compressMode ? 'true' : 'false'}
                                onClick={() => setCompressMode((prev) => !prev)}
                                className="flex-shrink-0 self-stretch flex items-center gap-1.5 text-xs px-2.5 py-1 rounded transition-colors"
                                style={browserActionButtonStyle(true, compressMode, { emphasizeWhenEnabled: true })}
                                title={compressMode
                                    ? 'Return to normal transcript spacing'
                                    : 'Compact transcript rows at transcript-detail zoom'}
                            >
                                Detail
                            </button>

                            <button
                                data-tour-id="browser-flatten"
                                data-tutorial-engaged={flattenMode ? 'true' : 'false'}
                                onClick={() => {
                                    if (!flattenMode) trackAchievement('browser.flatten')
                                    setFlattenMode((prev) => !prev)
                                }}
                                className="flex-shrink-0 self-stretch flex items-center gap-1.5 text-xs px-2.5 py-1 rounded transition-colors"
                                style={browserActionButtonStyle(true, flattenMode, { emphasizeWhenEnabled: true })}
                                title={flattenMode
                                    ? 'Return to normal track spacing'
                                    : 'Minimise empty vertical space in visible tracks'}
                            >
                                Flatten
                            </button>

                            {!isOverlayActive && (
                                <>
                                    <button
                                        data-tour-id="browser-unfocus"
                                        onClick={handleClearFocusedGenes}
                                        disabled={!anyFocusedGene}
                                        className="flex-shrink-0 self-stretch flex items-center gap-1.5 text-xs px-2.5 py-1 rounded transition-all duration-200"
                                        style={browserActionButtonStyle(anyFocusedGene, anyFocusedGene, { emphasizeWhenEnabled: true })}
                                        title="Clear all focused genes and locations across genomes"
                                    >
                                        Unfocus
                                    </button>

                                    <button
                                        data-tour-id="browser-pan"
                                        data-tutorial-engaged={lockPan ? 'true' : 'false'}
                                        onClick={() => {
                                            if (panelCount < 2) return
                                            const newPan = !lockPan
                                            if (!newPan && !lockZoom) {
                                                clearPendingLinkApply()
                                                linkModelRef.current = null
                                                setLinkedPanelKeys([])
                                            }
                                            setPanelPositions({})
                                            setLockPan(newPan)
                                            if (newPan && lockZoom) trackAchievement('browser.tandem')
                                        }}
                                        disabled={panelCount < 2}
                                        className="flex-shrink-0 self-stretch flex items-center gap-1.5 text-xs px-2.5 py-1 rounded transition-all duration-200"
                                        style={browserActionButtonStyle(panelCount >= 2, lockPan)}
                                        title={panelCount >= 2 ? 'Lock panning across linked genome panels' : 'Requires at least two visible genome panels'}
                                    >
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                                            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                                        </svg>
                                        Pan
                                    </button>

                                    <button
                                        data-tour-id="browser-zoom"
                                        data-tutorial-engaged={lockZoom ? 'true' : 'false'}
                                        onClick={() => {
                                            if (panelCount < 2) return
                                            const newZoom = !lockZoom
                                            if (!newZoom && !lockPan) {
                                                clearPendingLinkApply()
                                                linkModelRef.current = null
                                                setLinkedPanelKeys([])
                                            }
                                            setPanelPositions({})
                                            setLockZoom(newZoom)
                                            if (newZoom && lockPan) trackAchievement('browser.tandem')
                                        }}
                                        disabled={panelCount < 2}
                                        className="flex-shrink-0 self-stretch flex items-center gap-1.5 text-xs px-2.5 py-1 rounded transition-all duration-200"
                                        style={browserActionButtonStyle(panelCount >= 2, lockZoom)}
                                        title={panelCount >= 2 ? 'Lock zoom across linked genome panels' : 'Requires at least two visible genome panels'}
                                    >
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                                            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                                        </svg>
                                        Zoom
                                    </button>

                                    <button
                                        data-tour-id="browser-linkRegion"
                                        data-tutorial-engaged={linkModelRef.current?.type === 'region' ? 'true' : 'false'}
                                        onClick={handleLinkRegion}
                                        disabled={panelCount < 2 || linkingRegion}
                                        className="flex-shrink-0 self-stretch flex items-center gap-1.5 text-xs px-2.5 py-1 rounded transition-all duration-200"
                                        style={browserActionButtonStyle(panelCount >= 2, linkedPanelKeys.length >= 2 && linkModelRef.current?.type === 'region', { working: linkingRegion, emphasizeWhenEnabled: true })}
                                        title={panelCount >= 2 ? 'Link visible genome panels to the primary region and coordinates' : 'Requires at least two visible genome panels'}
                                    >
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                                            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                                        </svg>
                                        {linkingRegion ? 'Linking...' : 'Region'}
                                    </button>

                                    <button
                                        data-tour-id="browser-linkGene"
                                        data-tutorial-engaged={linkModelRef.current?.type === 'gene' ? 'true' : 'false'}
                                        onClick={handleLinkGene}
                                        disabled={panelCount < 2 || !anyFocusedGene || linkingGene}
                                        className="flex-shrink-0 self-stretch flex items-center gap-1.5 text-xs px-2.5 py-1 rounded transition-all duration-200"
                                        style={browserActionButtonStyle(panelCount >= 2 && anyFocusedGene, linkedPanelKeys.length >= 2, { working: linkingGene, emphasizeWhenEnabled: true })}
                                        title={
                                            panelCount < 2
                                                ? 'Requires at least two visible genome panels'
                                                : (anyFocusedGene ? 'Link focused genes across visible genomes' : 'Select a gene first')
                                        }
                                    >
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                                            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                                        </svg>
                                        {linkingGene ? 'Linking...' : 'Gene'}
                                    </button>
                                </>
                            )}

                            {(() => {
                                const chkStyle = {
                                    accentColor: isLight ? '#0099ff' : '#0077cc',
                                    cursor: 'pointer',
                                    width: '11px',
                                    height: '11px',
                                    flexShrink: 0,
                                }
                                const labelStyle = {
                                    color: isLight ? '#4b5563' : '#9ca3af',
                                    userSelect: 'none',
                                    cursor: 'pointer',
                                    whiteSpace: 'nowrap',
                                }
                                const toggle = (key) => {
                                    const next = { ...biotypeFilter, [key]: !biotypeFilter[key] }
                                    if (!Object.values(next).some(Boolean)) trackAchievement('browser.allClassesOff')
                                    setBiotypeFilter((prev) => ({ ...prev, [key]: !prev[key] }))
                                }
                                return (
                                    <>
                                        <div className="h-4 w-px flex-shrink-0 mx-1" style={{ backgroundColor: isLight ? '#dee2e6' : '#495057' }} />
                                        <div data-tour-id="browser-biotype-filter" className="grid gap-x-4 gap-y-0.5" style={{ gridTemplateColumns: 'auto auto', fontSize: '10px', lineHeight: '1.35' }}>
                                            <label className="flex items-center gap-1" style={labelStyle}>
                                                <input data-tour-id="browser-biotype-proteinCoding" type="checkbox" checked={biotypeFilter.proteinCoding} onChange={() => toggle('proteinCoding')} style={chkStyle} />
                                                Protein-coding
                                            </label>
                                            <label className="flex items-center gap-1" style={labelStyle}>
                                                <input data-tour-id="browser-biotype-lncRNA" type="checkbox" checked={biotypeFilter.lncRNA} onChange={() => toggle('lncRNA')} style={chkStyle} />
                                                Long non-coding
                                            </label>
                                            <label className="flex items-center gap-1" style={labelStyle}>
                                                <input data-tour-id="browser-biotype-pseudogene" type="checkbox" checked={biotypeFilter.pseudogene} onChange={() => toggle('pseudogene')} style={chkStyle} />
                                                Pseudogene
                                            </label>
                                            <label className="flex items-center gap-1" style={labelStyle}>
                                                <input data-tour-id="browser-biotype-smallNonCoding" type="checkbox" checked={biotypeFilter.smallNonCoding} onChange={() => toggle('smallNonCoding')} style={chkStyle} />
                                                Small non-coding
                                            </label>
                                        </div>
                                    </>
                                )
                            })()}
                        </>
                    )}
                </div>
                <div className="flex items-stretch flex-shrink-0 gap-2 ml-4" style={{ marginRight: '34px' }}>
                    <button
                        type="button"
                        data-tour-id="browser-controls-lock"
                        onClick={() => setControlsFollowScroll((prev) => !prev)}
                        aria-pressed={controlsFollowScroll}
                        // Square, and exactly as tall as the Cycle button beside it:
                        // both are an 18px line boxed in the same 7px padding and
                        // 1px border, so the two stay matched without a fixed size.
                        className="flex-shrink-0 flex items-center justify-center transition-colors"
                        style={{ ...browserActionButtonStyle(true, controlsFollowScroll), padding: '7px', borderRadius: '6px', lineHeight: 0 }}
                        aria-label={controlsFollowScroll
                            ? 'Controls unlocked and following the page: lock them back into place'
                            : 'Controls locked in place: unlock them to follow the page down'}
                        title={controlsFollowScroll
                            ? 'Unlocked: these controls follow the page down. Click to lock them back into place.'
                            : 'Locked: these controls stay put and scroll away with the page. Click to unlock them so they follow you down.'}
                    >
                        {/* The padlock the Feature Explorer locks splice paths with. */}
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                            <path d={controlsFollowScroll ? UNLOCKED_ICON_PATH : LOCKED_ICON_PATH} />
                        </svg>
                    </button>
                    {onPromoteGenome && <GenomeWheel
                        species={listedGenomes}
                        activeSpecies={panelSpecies}
                        config={config}
                        panelRootRef={screenshotPanelsRef}
                        onPromote={handleCyclePromote}
                        onPreview={setCyclePreview}
                        isActive={isActive && !screenshotMode}
                        isLight={isLight}
                        held={tutorialRunning}
                    />}
                </div>
            </div>

            {/* Portalled to the page, so it floats in the app's left-hand padding
                rather than scrolling away with the panels it is steering. */}
            <BrowserScrollRail
                panels={scrollRailStops}
                hostRef={screenshotPanelsRef}
                overlayRef={screenshotOverlayRootRef}
                onJump={alignPanelToTop}
                cyclePreview={cyclePreview}
                isActive={isActive && !screenshotMode && hasPanels}
                isLight={isLight}
                balanced
            />

            <div
                ref={screenshotPanelsRef}
                className={`relative w-full flex flex-col ${fillSinglePanelHeight ? '' : 'min-h-[220px]'} ${!hasPanels ? (isLight ? 'bg-white opacity-95' : 'bg-[#1E2938]') : ''}`}
                style={fillSinglePanelHeight ? growingPanelStyle : undefined}
            >
                {!hasPanels ? (
                    <div className="flex-1 min-h-[320px] w-full flex flex-col items-center justify-center p-6 bg-transparent">
                        <img
                            src="ensembl-e-blue.svg"
                            alt="Ensembl"
                            className={`mb-4 ${isLight ? 'opacity-80' : 'opacity-60 grayscale-[10%]'}`}
                            style={{ width: '130px', height: '130px' }}
                        />
                        <h2 className={`text-xl font-semibold mb-2 ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>No genomes selected</h2>
                        <p className={`text-sm text-center max-w-xl ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                            Select active genomes from the bar above or add/remove via the Genome Selector
                        </p>
                    </div>
                ) : (
                    panels.map((panel, idx) => {
                        const panelKey = panel.key
                        const trackBrowsePath = panel.customTrackBrowsePath || fallbackBrowseRoot
                        const useSecondaryPreset = panel.useSecondaryPreset
                        const panelReady = browserReadyState?.[panelKey]?.state || 'idle'
                        const panelDetail = browserReadyState?.[panelKey]?.detail || ''
                        // Only once the check has actually said so. Treating the
                        // initial 'idle' as ready mounted the browser before
                        // anything had been asked, so it fired a regions request
                        // of its own, took whatever error was going, and then
                        // unmounted when the first real check flipped to
                        // 'checking' — a wasted request and a visible flash.
                        const isReady = panelReady === 'ready'
                        const panelReloadKey = panel.alignmentRole === 'reference'
                            ? refReloadKey
                            : (panel.alignmentRole === 'target' ? tgtReloadKey : 0)

                        const drawerEntry = focusDrawerEntries.find((entry) => entry.panelKey === panelKey) || null
                        const panelLocation = selectedLocations[panelKey] || null
                        const drawerAlign = focusDrawerAlignByPanel[panelKey] || { top: 0, height: 0 }
                        const drawerPinOffset = activePinPanelKey === panelKey ? focusDrawerPinOffset : 0
                        // With a gene of focus the assembly drawer drops down onto
                        // the focus drawer's band line and takes its height, so the
                        // two headers read as one row across the panel. With no
                        // gene it goes back to the toolbar its pill sits in.
                        const assemblyAlign = ((drawerEntry || panelLocation) && drawerAlign.height)
                            ? drawerAlign
                            : (assemblyDrawerAlignByPanel[panelKey] || { top: 0, height: 0 })
                        const assemblyState = assemblyInfoByPanel[panelKey] || null
                        // Cleared past whatever drawer is currently out, so the
                        // two never sit on top of each other. Only one of them
                        // can be — a panel focuses a gene or a location, never both.
                        const focusDrawerCoverage = panelLocation
                            ? (!isLocationDrawerOpen(panelKey)
                                ? FOCUS_DRAWER_RAIL_WIDTH
                                : ((locationDetailByPanel[panelKey] || locationNotesPanelOpenByPanel[panelKey])
                                    ? LOCATION_DRAWER_DETAIL_WIDTH
                                    : FOCUS_DRAWER_WIDTH))
                            : !drawerEntry
                                ? 0
                                : !isFocusDrawerOpen(panelKey)
                                    ? FOCUS_DRAWER_RAIL_WIDTH
                                    : ((detailTranscriptByPanel[panelKey] || notesPanelOpenByPanel[panelKey])
                                        ? FOCUS_DRAWER_DETAIL_WIDTH
                                        : FOCUS_DRAWER_WIDTH)

                        return (
                            <div
                                key={panelKey}
                                // The drawer for this genome is positioned against
                                // this box, so it can never reach over the panel
                                // above or below however tall its list grows.
                                data-focus-panel-wrapper={panelKey}
                                data-tutorial-genome={panel.species.tutorial_dataset_id || undefined}
                                className="relative w-full flex flex-col"
                                style={fillSinglePanelHeight ? growingPanelStyle : undefined}
                            >
                                {incomingGene?.genomeKey === panelKey && (
                                    <div role="status" className={`absolute top-12 left-14 z-30 rounded px-3 py-2 text-sm ${isLight ? 'bg-white text-gray-700' : 'bg-gray-800 text-gray-200'}`}>
                                        Opening {incomingGene.gene.id}…
                                    </div>
                                )}
                                {incomingGeneError?.genomeKey === panelKey && (
                                    <div role="alert" className={`absolute top-12 left-14 right-4 z-30 rounded border p-3 text-sm flex items-center justify-between gap-3 ${isLight ? 'bg-red-50 border-red-200 text-red-800' : 'bg-red-950 border-red-800 text-red-200'}`}>
                                        <span>{incomingGeneError.message}</span>
                                        <button type="button" className="underline shrink-0" onClick={() => setIncomingGeneError(null)}>Dismiss</button>
                                    </div>
                                )}
                                {idx > 0 && (
                                    <div className="w-full flex-none" style={{ height: '2px', backgroundColor: isLight ? '#adb5bd' : '#373a40' }} />
                                )}
                                <div
                                    className="w-full flex flex-col overflow-visible"
                                    style={{
                                        ...growingPanelStyle,
                                        // A floor only. The browser inside lays its tracks out at
                                        // full height and overflows onto the page rather than into
                                        // a nested scroll area.
                                        minHeight: useAdaptivePanelHeight ? 0 : (panelMinHeight || 0),
                                        height: 'auto',
                                    }}
                                >
                                    {isReady ? (
                                        <GenomeBrowser
                                            key={panelKey}
                                            isActive={isActive}
                                            genome={panel.genomeParam}
                                            tutorialRecipeId={panel.species.tutorial_dataset_id || ''}
                                            tutorialActive={tutorialRunning}
                                            geneNoteCounts={noteCountsByPanel[panelKey] || EMPTY_NOTE_COUNTS}
                                            onOpenGeneNotes={panelCallbacks[panelKey].onOpenGeneNotes}
                                            alignmentRole={panel.alignmentRole}
                                            reloadEpoch={panelReloadKey}
                                            theme={theme}
                                            label={panel.label}
                                            genomePillLabel={panel.genomePillLabel}
                                            genomeColor={resolveGenomeColor(panel.species)}
                                            onGenomePillClick={panelCallbacks[panelKey].onGenomePillClick}
                                            genomePillExpanded={Boolean(assemblyDrawerOpenByPanel[panelKey])}
                                            toolbarPosition="top"
                                            rulerPosition="top"
                                            focusBarPosition="top"
                                            trackAlign="top"
                                            showSequenceTrack={true}
                                            sequenceTrackPosition="bottom"
                                            sequenceTrackLabel="SL"
                                            sequenceTrackTooltip={useSecondaryPreset
                                                ? 'Base level view of the secondary genome'
                                                : 'Base level view of the primary genome'}
                                            customTrackBrowsePath={trackBrowsePath}
                                            availableTracks={availableTracksByPanel[panelKey] || EMPTY_TRACK_LIST}
                                            availableGroups={availableGroupsByPanel[panelKey] || EMPTY_TRACK_LIST}
                                            sessionTracks={sessionTracksByGenome?.[trackAssemblyKey(getGenomeKey(panel.species))]?.entries || null}
                                            sessionReady={sessionReady}
                                            onSessionTracksChange={sessionActive ? sessionHandlerFor(trackAssemblyKey(getGenomeKey(panel.species))) : null}
                                            refreshAvailableTracks={refreshRegisteredTracks}
                                            tutorialTracksRequest={browserTracksRequest}
                                            onTutorialHideInactive={setHideInactiveMode}
                                            onTrackVisibilityChange={panelCallbacks[panelKey].onTrackVisibilityChange}
                                            forceTracksVisibility={forceTracksVisibility}
                                            hideInactiveTracks={hideInactiveMode}
                                            compressTranscripts={compressMode}
                                            flattenTracks={flattenMode}
                                            adaptiveHeight={useAdaptivePanelHeight}
                                            hiddenBiotypeClasses={hiddenBiotypeClasses}
                                            dimNonSelectedGenes={config?.dim_non_selected_genes !== false}
                                            alignmentOverlay={panel.alignmentRole ? alignmentOverlay : null}
                                            onPositionChange={panelCallbacks[panelKey].onPositionChange}
                                            onViewSync={panelCallbacks[panelKey].onViewSync}
                                            onNearViewportChange={panelCallbacks[panelKey].onNearViewportChange}
                                            minCanvasHeight={Math.max(
                                                sharedCanvasHeight,
                                                locationDrawerFitByPanel[panelKey]
                                                    ? (panelContentHeights[panelKey] || 0) + locationDrawerFitByPanel[panelKey]
                                                    : 0
                                            )}
                                            onContentHeightChange={panelCallbacks[panelKey].onContentHeightChange}
                                            browsingControls={browsingControls}
                                            onBrowsingTargetChange={panelCallbacks[panelKey].onBrowsingTargetChange}
                                            externalPosition={
                                                (effectiveLockPan || effectiveLockZoom) && syncSourcePanelKeyRef.current !== panelKey
                                                    ? (holdFarPanels && farPanelKeys.has(panelKey) && heldPanelPositions && panelKey in heldPanelPositions
                                                        ? heldPanelPositions[panelKey]
                                                        : (panelPositions[panelKey] || null))
                                                    : null
                                            }
                                            lockPan={effectiveLockPan}
                                            lockZoom={effectiveLockZoom}
                                            onGeneSelect={panelCallbacks[panelKey].onGeneSelect}
                                            onLocationSelect={panelCallbacks[panelKey].onLocationSelect}
                                            hiddenGeneIds={locationHiddenGenesByPanel[panelKey] || null}
                                            focusTranscriptView={focusTranscriptViews[panelKey] || null}
                                            geneTranscriptViews={geneTranscriptViews[panelKey] || null}
                                            focusDrawerInset={focusDrawerInsetFor(panelKey)}
                                            focusDrawerInsetOnFocus={FOCUS_DRAWER_WIDTH}
                                            onFocusTranscriptsChange={panelCallbacks[panelKey].onFocusTranscriptsChange}
                                            onFocusTranscriptViewChange={panelCallbacks[panelKey].onFocusTranscriptViewChange}
                                            onFocusRowGeometryChange={panelCallbacks[panelKey].onFocusRowGeometryChange}
                                            onGeneTranscriptViewChange={panelCallbacks[panelKey].onGeneTranscriptViewChange}
                                            navigateToGene={navigateGenes[panelKey] || null}
                                            navigateToLocation={externalFocusLocationsByGenome?.[panelKey] || null}
                                            onManualNavigate={handleManualBrowserNavigate}
                                            clearFocusEpoch={clearFocusEpoch + (panelClearEpochs[panelKey] || 0)}
                                            screenshotTargetId={panelKey}
                                            onScreenshotTargetChange={panelCallbacks[panelKey].onScreenshotTargetChange}
                                        />
                                    ) : (
                                        <IndexPreparingNotice
                                            isLight={isLight}
                                            state={panelReady}
                                            detail={panelDetail}
                                            onRetry={() => retryGenomeIndex(panel)}
                                        />
                                    )}
                                </div>

                                {drawerEntry && (
                                    <FocusGeneDrawer
                                        theme={theme}
                                        open={isFocusDrawerOpen(panelKey)}
                                        onToggle={() => setFocusDrawerOpenByPanel((prev) => {
                                            const wasOpen = prev[panelKey] !== false
                                            // Collapsing hides the list the pin belongs to, so the
                                            // highlight it holds in the browser has nothing left to
                                            // point at. Let it go rather than stranding it.
                                            if (wasOpen) {
                                                setDetailTranscriptByPanel((all) => ({ ...all, [panelKey]: '' }))
                                                setNotesPanelOpenByPanel((all) => ({ ...all, [panelKey]: false }))
                                                handleFocusTranscriptViewChange(panelKey, {
                                                    pinnedId: null, hoverId: null, ghostId: null,
                                                })
                                            }
                                            return { ...prev, [panelKey]: !wasOpen }
                                        })}
                                        onDismiss={() => handleClearPanelFocus(panelKey)}
                                        entries={[drawerEntry]}
                                        activePanelKey={panelKey}
                                        view={focusTranscriptViews[panelKey] || null}
                                        onViewChange={(patch) => handleFocusTranscriptViewChange(panelKey, patch)}
                                        showPanelSwitcher={false}
                                        alignTop={drawerAlign.top}
                                        alignHeight={drawerAlign.height}
                                        pinOffset={drawerPinOffset}
                                        stickyTopInset={focusDrawerStickyInset}
                                        listShift={detailListShiftByPanel[panelKey] || 0}
                                        genome={panel.genomeParam}
                                            tutorialRecipeId={panel.species.tutorial_dataset_id || ''}
                                            tutorialActive={tutorialRunning}
                                        detailTranscriptId={detailTranscriptByPanel[panelKey] || ''}
                                        onDetailTranscriptChange={(id) => handleDetailTranscriptChange(panelKey, id)}
                                        notesEnabled={Boolean(notesGenomeKeyFor(panel))}
                                        // Selected out of the loaded store, so this
                                        // is always exactly this gene's notes — there
                                        // is no per-gene fetch left to lag behind.
                                        notes={notesByPanel[panelKey] || EMPTY_NOTE_LIST}
                                        notesStatus={noteStore.status}
                                        notesError={noteStore.error}
                                        notesPanelOpen={Boolean(notesPanelOpenByPanel[panelKey])}
                                        onNotesPanelToggle={() => handleNotesPanelToggle(panelKey)}
                                        openNoteId={openNoteIdByPanel[panelKey] || ''}
                                        onOpenNoteChange={(id) => handleOpenNoteChange(panelKey, id)}
                                        noteSortMode={noteSortByPanel[panelKey] || DEFAULT_NOTE_SORT_MODE}
                                        onNoteSortChange={(mode) => setNoteSortByPanel((prev) => ({ ...prev, [panelKey]: mode }))}
                                        noteSaveState={noteStore.saveStateFor(openNoteIdByPanel[panelKey] || '')}
                                        onNoteCreate={() => handleNoteCreate(panelKey)}
                                        onNoteFieldChange={(id, patch) => noteStore.updateNoteFields(id, patch)}
                                        onNoteSave={(id, options) => noteStore.saveNote(id, options)}
                                        onNoteDelete={(id) => handleNoteDelete(panelKey, id)}
                                        onNotesReload={(noteId) => noteStore.reload({ noteId })}
                                    />
                                )}

                                {panelLocation && (
                                    <FocusLocationDrawer
                                        theme={theme}
                                        open={isLocationDrawerOpen(panelKey)}
                                        onToggle={() => setLocationDrawerOpenByPanel((prev) => {
                                            const wasOpen = prev[panelKey] !== false
                                            // Collapsing puts away what was open beside the
                                            // list: the wide slot has nothing to hang off.
                                            if (wasOpen) {
                                                setLocationDetailByPanel((all) => ({ ...all, [panelKey]: null }))
                                                setLocationNotesPanelOpenByPanel((all) => ({ ...all, [panelKey]: false }))
                                            }
                                            return { ...prev, [panelKey]: !wasOpen }
                                        })}
                                        onDismiss={() => handleClearPanelFocus(panelKey)}
                                        location={panelLocation}
                                        genome={panel.genomeParam}
                                        genomeLabel={panel.genomePillLabel || panel.label}
                                        accent={resolveGenomeColor(panel.species)}
                                        alignTop={drawerAlign.top}
                                        alignHeight={drawerAlign.height}
                                        stickyTopInset={focusDrawerStickyInset}
                                        features={locationFeaturesByPanel[panelKey] || null}
                                        onFeaturesReload={() => setLocationFeaturesEpoch((prev) => prev + 1)}
                                        isFeatureHiddenByClass={isFeatureHiddenByClass}
                                        hiddenGeneIds={locationHiddenGenesByPanel[panelKey] || null}
                                        onToggleGeneHidden={(geneId) => handleLocationGeneHiddenToggle(panelKey, geneId)}
                                        onFocusGene={(gene) => handleLocationFocusGene(panelKey, gene)}
                                        detail={locationDetailByPanel[panelKey] || null}
                                        onDetailChange={(detail) => handleLocationDetailChange(panelKey, detail)}
                                        onHeightFitChange={(delta) => handleLocationDrawerFit(panelKey, delta)}
                                        notesEnabled={Boolean(notesGenomeKeyFor(panel))}
                                        notes={locationNotesByPanel[panelKey] || EMPTY_NOTE_LIST}
                                        notesStatus={noteStore.status}
                                        notesError={noteStore.error}
                                        notesPanelOpen={Boolean(locationNotesPanelOpenByPanel[panelKey])}
                                        onNotesPanelToggle={() => handleLocationNotesPanelToggle(panelKey)}
                                        openNoteId={locationOpenNoteIdByPanel[panelKey] || ''}
                                        onOpenNoteChange={(id) => setLocationOpenNoteIdByPanel((prev) => ({ ...prev, [panelKey]: id }))}
                                        noteSortMode={locationNoteSortByPanel[panelKey] || DEFAULT_NOTE_SORT_MODE}
                                        onNoteSortChange={(mode) => setLocationNoteSortByPanel((prev) => ({ ...prev, [panelKey]: mode }))}
                                        noteSaveState={noteStore.saveStateFor(locationOpenNoteIdByPanel[panelKey] || '')}
                                        onNoteCreate={() => handleLocationNoteCreate(panelKey)}
                                        onNoteFieldChange={(id, patch) => noteStore.updateNoteFields(id, patch)}
                                        onNoteSave={(id, options) => noteStore.saveNote(id, options)}
                                        onNoteDelete={(id) => handleLocationNoteDelete(panelKey, id)}
                                        onNotesReload={(noteId) => noteStore.reload({ noteId })}
                                    />
                                )}

                                {assemblyDrawerOpenByPanel[panelKey] && (
                                    <AssemblyInfoDrawer
                                        theme={theme}
                                        open
                                        onClose={() => closeAssemblyDrawer(panelKey)}
                                        genome={panel.species}
                                        assemblyInfo={assemblyState?.info || null}
                                        loading={assemblyState?.loading !== false}
                                        accentColor={resolveGenomeColor(panel.species)}
                                        label={panel.genomePillLabel || panel.label}
                                        alignTop={assemblyAlign.top}
                                        alignHeight={assemblyAlign.height}
                                        stickyTopInset={focusDrawerStickyInset}
                                        rightInset={focusDrawerCoverage}
                                    />
                                )}
                            </div>
                        )
                    })
                )}

                {panelsBottomSpacer > 0 && (
                    // Empty page under the last genome, so it can be scrolled up
                    // to the top bar like any other. Not a gap between panels:
                    // it only exists past the end of the final one.
                    <div className="w-full flex-none" style={{ height: panelsBottomSpacer }} aria-hidden="true" />
                )}

            </div>

            <ScreenshotSelectionOverlay
                active={screenshotMode && hasPanels}
                theme={theme}
                containerRef={screenshotOverlayRootRef}
                scrollContainerRef={screenshotPanelsRef}
                exemptRefs={[screenshotToggleButtonRef]}
                useViewport={true}
                targets={screenshotTargets}
                onSelect={(target) => {
                    setSelectedScreenshotTarget(target)
                    onScreenshotModeChange?.(false)
                }}
                onCancel={() => {
                    onScreenshotModeChange?.(false)
                }}
            />

            <ScreenshotExportModal
                open={Boolean(selectedScreenshotTarget)}
                theme={theme}
                target={selectedScreenshotTarget}
                outputDir={defaultScreenshotDir}
                onSave={handleScreenshotSave}
                onClose={handleScreenshotModalClose}
            />

        </div>
    )
}

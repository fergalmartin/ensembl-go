// The app shell's rendered layout: top bar with view buttons and genome pills,
// the organiser drawer and playlist popover, the current view (with the Genome
// Browser kept mounted and hidden when another view is shown), and the app-level
// modals. Returned by App (a plain call, not a separate component).
import React from 'react'
import { trackAchievement } from '../../achievements/tracker.js'
import { DRAWER_BORDER_PX, DRAWER_PADDING_X, TOP_BAR_SCROLL_ARROW_PX } from '../../app/appLayout.js'
import { dedupeSpeciesList, speciesItemKey } from '../../app/genomeLists.js'
import { APP_BUTTON_META, TOP_BAR_BUTTON_PX, TOP_BAR_GAP_PX, TOP_BAR_VIEWPORT_PX } from '../../appButtonConfig.js'
import { API_BASE } from '../../backendRuntime.js'
import { playlistTourSlug } from '../../utils/playlistGenomes.js'
import AchievementsView from '../achievements/AchievementsView'
import AchievementToastHost from '../achievements/AchievementToast'
import ActiveTasksButton from '../ActiveTasksButton'
import AppButtonIcon from '../AppButtonIcon'
import AppOrganiserPanel from '../AppOrganiserPanel'
import ConfigurationView from '../ConfigurationView'
import DownloadView from '../DownloadView'
import FeatureExplorerView from '../FeatureExplorerView'
import FeatureLegend from '../FeatureLegend'
import GenomeBrowserView from '../genome-browser/GenomeBrowserView'
import GenomeSelectorView from '../GenomeSelectorView'
import GettingStartedOutputDirPrompt from '../GettingStartedOutputDirPrompt'
import HelpView from '../HelpView'
import HomeView from '../HomeView'
import HomologyView from '../HomologyView'
import LoadAlignmentModal from '../LoadAlignmentModal'
import MultiAlignmentPanel from '../MultiAlignmentPanel'
import MultiAlignmentSidebar from '../MultiAlignmentSidebar'
import NeighbourhoodView from '../NeighbourhoodView'
import NoGenomesPillsMessage from '../NoGenomesPillsMessage'
import NotesView from '../NotesView'
import SaveAlignmentModal from '../SaveAlignmentModal'
import ScreenshotExportModal from '../ScreenshotExportModal'
import ScreenshotSelectionOverlay from '../ScreenshotSelectionOverlay'
import SelectedSpeciesPillsBar from '../SelectedSpeciesPillsBar'
import StatsView from '../StatsView'
import StructuralVariationView from '../StructuralVariationView'
import TrackManagerView from '../TrackManagerView'
import TutorialsView from '../TutorialsView'
import WindowsBackendSetupView from '../WindowsBackendSetupView'

export function renderAppLayout(ctx) {
    const {
        AlignmentExplorerView,
        ErrorBoundary,
        FpsCounter,
        GeneTreesView,
        PILLS_STRIP_HEIGHT,
        PILLS_STRIP_PADDING_BOTTOM,
        PILLS_STRIP_PADDING_TOP,
        PILLS_STRIP_PADDING_X,
        SequenceView,
        achievementFocusId,
        activeAppButtons,
        activeSpeciesByKey,
        alignedGenomeCount,
        alignmentDisplayMetaByGenomeKey,
        alignmentDisplayRows,
        alignmentGenomeColorsByKey,
        alignmentGlobalFlankMax,
        alignmentGlobalFlanks,
        alignmentGlobalFlanksLocked,
        alignmentInputs,
        alignmentNeedsRerun,
        alignmentPreparedCount,
        alignmentRunDisabled,
        alignmentRunSettings,
        alignmentSidebarCollapsed,
        alignmentViewError,
        alignmentViewLoading,
        alignmentViewerDisplayKey,
        appOrganiserButtonRef,
        appOrganiserOpen,
        appOrganiserPanelRef,
        applyingGenomePlaylistId,
        backendRuntime,
        browserGeneEntry,
        browserLocationFocusByGenome,
        browserRefGene,
        browserRefViewport,
        browserTgtGene,
        collapseIntrons,
        collapseSource,
        collapseSourceOptions,
        config,
        configLoaded,
        currentView,
        currentViewButtonId,
        currentViewDescription,
        currentViewTitle,
        defaultFallbackScreenshotDir,
        dragOverTopButtonId,
        dragTopInsertPosition,
        draggedTopButtonId,
        explorerIncoming,
        fallbackScreenshotOverlayRef,
        fallbackScreenshotTarget,
        fallbackScreenshotTargets,
        featureExplorerActiveGenome,
        featureExplorerActiveGenomeKey,
        featureExplorerAvailableGenomes,
        featureExplorerSeedQuery,
        focusGeneByGenome,
        geneTreesIncoming,
        genomePlaylistActionButtonRef,
        genomePlaylistPopoverOpen,
        genomePlaylistPopoverPosition,
        genomePlaylistPopoverRef,
        genomeStartingPoints,
        gettingStartedOutputDirDismissed,
        handleAlignmentGlobalFlankMaxChange,
        handleAlignmentGlobalFlanksChange,
        handleAlignmentGlobalFlanksLockToggle,
        handleAlignmentResolveRow,
        handleAlignmentRowQueryChange,
        handleAlignmentRowSettingChange,
        handleAlignmentRunSettingsChange,
        handleAlignmentSearchAll,
        handleAppOrganiserChange,
        handleApplyPlaylistFromSelector,
        handleBrowserGeneEntryConsumed,
        handleClearAllFocusedGenes,
        handleConfigSaved,
        handleConfigurationChange,
        handleDoSaveAlignment,
        handleFallbackScreenshotModalClose,
        handleFallbackScreenshotSave,
        handleFeatureExplorerGenomeSelect,
        handleGenomeFocusGeneSelect,
        handleGenomeFocusLocationSelect,
        handleGenomeWheelPromote,
        handleGettingStartedOutputDir,
        handleLoadAlignment,
        handleNeighbourhoodFlipGenome,
        handleNeighbourhoodLinkSelect,
        handleNeighbourhoodResolveGenome,
        handleNeighbourhoodSearchAll,
        handleNeighbourhoodSwapAdjacent,
        handleNeighbourhoodToggleGenome,
        handleNeighbourhoodUseHomologyClick,
        handleOpenAlignmentExplorerLoci,
        handleRefGeneSelect,
        handleRemoveSpeciesFromList,
        handleRetryBackendCheck,
        handleRetryBackendLaunch,
        handleSaveAlignment,
        handleScreenshotAvailabilityChange,
        handleSelectorConfigChange,
        handleSpeciesPillReorder,
        handleSpeciesPillToggle,
        handleSpeciesToggleFromSelector,
        handleStructuralVariationGenomeOrderChange,
        handleStructuralVariationPillToggle,
        handleSvAlignmentAvailabilityChange,
        handleTgtGeneSelect,
        handleTopBarButtonClick,
        handleTopBarPlaylistSelect,
        headerCollapsed,
        homologyGenomes,
        homologyWorkspace,
        inactiveSelectedSpecies,
        isLight,
        loadAlignmentModalOpen,
        mainContentNode,
        multiAlignmentResult,
        neighbourhoodDisabledByGenome,
        neighbourhoodErrorStateByGenome,
        neighbourhoodGenomes,
        neighbourhoodHomologyAvailabilityByGenome,
        neighbourhoodHomologyError,
        neighbourhoodHomologyFilters,
        neighbourhoodHomologyLinksByPair,
        neighbourhoodHomologyPairLoading,
        neighbourhoodLinksByPair,
        neighbourhoodLoadingStateByGenome,
        neighbourhoodNoHitGenomeKeys,
        neighbourhoodQueryStateByGenome,
        neighbourhoodTrackStateByGenome,
        neighbourhoodUseHomology,
        organiserScrollRef,
        outputDirNotification,
        refBrowserReloadKey,
        refSpecies,
        reorderTopBarButtons,
        reportBrowserRefViewport,
        reserveTutorialSelectorPills,
        runMultiAlignment,
        saveAlignmentModalOpen,
        screenshotActionButtonRef,
        screenshotAvailable,
        screenshotMode,
        scrollTopBarButtons,
        selectedFallbackScreenshotTarget,
        selectedSpeciesKeysForView,
        selectorPlaylistConfig,
        selectorSelectedSpecies,
        semiSelectedSpeciesKeysForView,
        sequenceViewEntry,
        setAchievementFocusId,
        setActiveViewContentNode,
        setAlignmentSidebarCollapsed,
        setAppOrganiserOpen,
        setBackendSetupOpen,
        setBrowserFocusByGenome,
        setBrowserGeneEntry,
        setCollapseIntrons,
        setCollapseSource,
        setCurrentView,
        setDragOverTopButtonId,
        setDragTopInsertPosition,
        setDraggedTopButtonId,
        setExplorerIncoming,
        setGeneTreesIncoming,
        setGettingStartedOutputDirDismissed,
        setHeaderCollapsed,
        setLoadAlignmentModalOpen,
        setMainContentNode,
        setNeighbourhoodErrorByGenome,
        setNeighbourhoodHomologyFilters,
        setNeighbourhoodQueryByGenome,
        setSaveAlignmentModalOpen,
        setScreenshotMode,
        setSelectedFallbackScreenshotTarget,
        setSequenceGenomeKey,
        setSequenceViewEntry,
        setSvAnchorRegionId,
        setSvRegionExplicitlySelected,
        shouldRenderFallbackContentWrapper,
        shouldShowWindowsBackendSetup,
        showNoGenomesMessage,
        showsPillsStrip,
        sortedGenomePlaylists,
        statsActiveGenomeKeys,
        structuralVariationViewKey,
        svAnchorPillLabel,
        svAnchorRegionId,
        svAnchorSpecies,
        svRegionExplicitlySelected,
        svSavedViewportRef,
        svSecondPillLabel,
        svSecondSpecies,
        svThirdPillLabel,
        svThirdSpecies,
        tgtBrowserReloadKey,
        theme,
        themeStyles,
        topBarButtonLayout,
        topBarButtonRows,
        topBarDragMovedRef,
        topBarScroll,
        topBarScrollRef,
        topBarSpecies,
        topListMode,
        tutorialRuntime,
        unalignedGenomeCount,
        userConfig,
        usingFallbackScreenshot,
    } = ctx
    return (
<div className={`h-screen flex flex-col ${themeStyles.bg} ${themeStyles.text}`}>
      {config.show_fps_counter && <FpsCounter />}
      {/* Header */}
      <header
        /* The pills strip ends in the assembly badges, which already sit at the foot of
           the pills; a full `pb-4` under that read as a gap rather than as breathing
           room. With no strip below them the button rows still want the full padding. */
        className={`${themeStyles.header} border-b px-6 ${headerCollapsed ? 'py-3 cursor-pointer' : `pt-4 ${showsPillsStrip ? 'pb-2' : 'pb-4'}`} flex-none rounded-xl relative`}
        onClick={headerCollapsed ? () => setHeaderCollapsed(false) : undefined}
      >
        <div className={`flex flex-col ${headerCollapsed ? 'gap-0' : 'gap-3'} w-full h-full`}>
          <div className={`flex items-start justify-between gap-4 w-full ${headerCollapsed ? '' : 'h-full'}`}>
            <div className="min-w-0 flex-1 pr-2">
              <div className={`min-w-0 overflow-hidden ${themeStyles.text} flex ${headerCollapsed ? 'items-end' : 'items-center'} gap-1`}>
                <span className="flex shrink-0 items-center gap-1.5">
                  <img src="ensembl-logotype-blue.svg" alt="Ensembl" className="h-6" />
                  <span className={`leading-none font-normal ${isLight ? 'text-gray-900' : 'text-white'}`} style={{fontSize: '30px'}}>Go</span>
                </span>
                {headerCollapsed && (
                  <h1
                    className={`ml-2 min-w-0 truncate font-normal leading-none ${isLight ? 'text-gray-900' : 'text-white'}`}
                    style={{ fontSize: '24px' }}
                    title={currentViewTitle}
                  >
                    {currentViewTitle}
                  </h1>
                )}
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation()
                    if (!headerCollapsed) trackAchievement('topbar.collapse')
                    setHeaderCollapsed((prev) => !prev)
                  }}
                  className="w-8 h-8 shrink-0 rounded-md border-0 bg-transparent text-[#0099ff] flex items-center justify-center transition-colors hover:bg-[#0099ff]/10"
                  title={headerCollapsed ? 'Expand top bar' : 'Collapse top bar'}
                  aria-label={headerCollapsed ? 'Expand top bar' : 'Collapse top bar'}
                >
                  <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round">
                    {headerCollapsed ? <polyline points="6 9 12 15 18 9" /> : <polyline points="18 15 12 9 6 15" />}
                  </svg>
                </button>
              </div>
              {!headerCollapsed && (
                <div className="mt-2 min-w-0 flex items-start gap-3">
                  {currentViewButtonId && (
                    <span
                      aria-hidden="true"
                      className="w-11 h-11 shrink-0 rounded-lg bg-[#0099ff] text-white flex items-center justify-center overflow-hidden"
                    >
                      <AppButtonIcon buttonId={currentViewButtonId} isLight={isLight} />
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <h1
                      className={`min-w-0 truncate font-normal leading-none ${isLight ? 'text-gray-900' : 'text-white'}`}
                      style={{ fontSize: '24px' }}
                      title={currentViewTitle}
                    >
                      {currentViewTitle}
                    </h1>
                    <p className={`text-sm ${themeStyles.subtext} mt-1 text-left leading-snug whitespace-normal break-words`}>
                      {currentViewDescription}
                    </p>
                  </div>
                </div>
              )}
            </div>
            {!headerCollapsed && !shouldShowWindowsBackendSetup && (
              <div className="shrink-0 flex items-start gap-2">
                <div className="flex items-start gap-1.5">
                  <div className="relative">
                  <div
                    ref={topBarScrollRef}
                    className="overflow-x-auto overflow-y-hidden hide-scrollbar"
                    style={{ maxWidth: TOP_BAR_VIEWPORT_PX }}
                  >
                    <div className="flex flex-col items-start gap-2 w-max">
                  {topBarButtonRows.map((row, rowIndex) => (
                    <div
                      key={`topbar-row-${rowIndex}`}
                      className="grid gap-2 justify-items-start"
                      style={{ gridTemplateColumns: `repeat(${topBarButtonLayout.columns}, ${TOP_BAR_BUTTON_PX}px)` }}
                    >
                      {row.map((buttonId) => {
                        const buttonMeta = APP_BUTTON_META[buttonId]
                        if (!buttonMeta) return null
                        const isActionButton = buttonMeta.kind === 'action'
                        const isSelectedView = buttonMeta.kind === 'data_view' && buttonMeta.viewId === currentView
                        const isActionActive = isActionButton && (
                          (buttonId === 'screenshot_toggle' && screenshotMode) ||
                          (buttonId === 'genome_playlist' && genomePlaylistPopoverOpen)
                        )
                        const isTopButtonActive = isSelectedView || isActionActive
                        const isActionDisabled = isActionButton && buttonId === 'screenshot_toggle' && !screenshotAvailable
                        const isDragging = draggedTopButtonId === buttonId
                        const isDropTarget = Boolean(
                          dragOverTopButtonId &&
                          draggedTopButtonId &&
                          dragOverTopButtonId === buttonId &&
                          draggedTopButtonId !== buttonId
                        )
                        const insertLineColor = isLight ? 'rgba(0, 153, 255, 0.92)' : 'rgba(125, 211, 252, 0.92)'
                        const buttonNode = (
                          <button
                            key={buttonId}
                            data-tour-id={`app-button-${buttonId}`}
                            ref={buttonId === 'screenshot_toggle'
                              ? screenshotActionButtonRef
                              : (buttonId === 'genome_playlist' ? genomePlaylistActionButtonRef : null)}
                            onClick={() => {
                              if (topBarDragMovedRef.current) {
                                topBarDragMovedRef.current = false
                                return
                              }
                              if (isActionDisabled) return
                              handleTopBarButtonClick(buttonId)
                            }}
                            draggable
                            onDragStart={(event) => {
                              event.dataTransfer.effectAllowed = 'move'
                              event.dataTransfer.setData('text/plain', buttonId)
                              setDraggedTopButtonId(buttonId)
                              setDragOverTopButtonId(buttonId)
                              setDragTopInsertPosition('before')
                              topBarDragMovedRef.current = false
                            }}
                            onDragOver={(event) => {
                              if (!draggedTopButtonId || draggedTopButtonId === buttonId) return
                              event.preventDefault()
                              event.dataTransfer.dropEffect = 'move'
                              const rect = event.currentTarget.getBoundingClientRect()
                              const nextInsertPosition = event.clientX < (rect.left + rect.width / 2) ? 'before' : 'after'
                              setDragOverTopButtonId(buttonId)
                              setDragTopInsertPosition(nextInsertPosition)
                              topBarDragMovedRef.current = true
                            }}
                            onDrop={(event) => {
                              event.preventDefault()
                              const source = draggedTopButtonId || event.dataTransfer.getData('text/plain')
                              reorderTopBarButtons(source, buttonId, dragTopInsertPosition)
                              setDraggedTopButtonId('')
                              setDragOverTopButtonId('')
                              setDragTopInsertPosition('before')
                              topBarDragMovedRef.current = false
                            }}
                            onDragEnd={() => {
                              setDraggedTopButtonId('')
                              setDragOverTopButtonId('')
                              setDragTopInsertPosition('before')
                              setTimeout(() => { topBarDragMovedRef.current = false }, 0)
                            }}
                            className={`w-11 h-11 rounded-lg flex items-center justify-center transition-all duration-200 relative ${(isTopButtonActive && !isActionDisabled)
                              ? (isActionButton
                                ? 'bg-[#bfe6ff] text-[#006fbf] shadow-md shadow-[#0099ff]/25 border-2 border-[#0099ff]'
                                : 'bg-[#0077cc] text-white shadow-md shadow-[#0077cc]/40 border-2 border-white/40')
                              : (isActionDisabled
                                ? 'bg-[#6b7280] text-white/60 border-2 border-transparent cursor-not-allowed'
                                : (isActionButton
                                  ? 'bg-[#e1f4ff] text-[#0077cc] hover:text-[#005f9f] hover:bg-[#cbeeff] border-2 border-[#0099ff]'
                                  : 'bg-[#0099ff] text-white/80 hover:text-white hover:bg-[#0088ee] border-2 border-transparent'))
                              }`}
                            style={{
                              opacity: isDragging ? 0.62 : 1,
                              boxShadow: isDropTarget
                                ? (dragTopInsertPosition === 'before'
                                  ? `inset 3px 0 0 ${insertLineColor}`
                                  : `inset -3px 0 0 ${insertLineColor}`)
                                : undefined,
                              cursor: isActionDisabled ? 'not-allowed' : 'pointer',
                            }}
                            title={buttonId === 'theme_toggle'
                              ? (isLight ? 'Switch to Dark Mode' : 'Switch to Light Mode')
                              : buttonId === 'genome_playlist'
                                ? 'Choose a genome playlist'
                              : buttonId === 'screenshot_toggle'
                                ? (screenshotAvailable
                                  ? (screenshotMode ? 'Cancel screenshot capture' : 'Capture a screenshot from this view')
                                  : 'No exportable screenshot panels are available in this view')
                              : buttonMeta.label}
                          >
                            {buttonId === 'track_manager' ? (
                              <span style={{ display: 'inline-flex', transform: 'scale(0.76)' }}>
                                <AppButtonIcon buttonId={buttonId} isLight={isLight} />
                              </span>
                            ) : (
                              <AppButtonIcon buttonId={buttonId} isLight={isLight} />
                            )}
                            {isTopButtonActive && !isActionDisabled && (
                              <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-6 h-[3px] rounded-full bg-white shadow-sm"></span>
                            )}
                          </button>
                        )
                        return buttonNode
                      })}
                    </div>
                  ))}
                    </div>
                  </div>

                  {/* The playlist popover. It hangs off this wrapper rather than off its
                      button because the button sits inside the horizontally scrolling
                      strip, which clips anything that drops below its rows. Placed from
                      the button's measured edges instead; see the effect that sets
                      `genomePlaylistPopoverPosition`. */}
                  {activeAppButtons.includes('genome_playlist') && (
                  <div
                    ref={genomePlaylistPopoverRef}
                    data-tour-id={genomePlaylistPopoverOpen ? 'app-playlist-popover' : undefined}
                    style={genomePlaylistPopoverPosition}
                    className={`absolute w-72 origin-top-right rounded-xl border shadow-2xl z-50 overflow-hidden transition-all duration-200 ${genomePlaylistPopoverOpen
                      ? 'opacity-100 translate-y-0 pointer-events-auto'
                      : 'opacity-0 -translate-y-2 pointer-events-none'
                    } ${isLight ? 'bg-white border-gray-200 text-gray-900' : 'bg-gray-900 border-gray-700 text-gray-100'}`}
                  >
                    <div className={`px-4 py-3 border-b ${isLight ? 'border-gray-100 bg-gray-50' : 'border-gray-700 bg-gray-800'}`}>
                      <div className="text-sm font-bold">Genome Playlists</div>
                    </div>
                    <div className="max-h-80 overflow-y-auto themed-scrollbar">
                      {sortedGenomePlaylists.length === 0 ? (
                        <div className={`px-4 py-4 text-sm ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                          No playlists yet.
                        </div>
                      ) : sortedGenomePlaylists.map((playlist) => {
                        const isSelectedPlaylist = String(config?.selected_genome_playlist_id || '') === playlist.id
                        const isApplying = applyingGenomePlaylistId === playlist.id
                        return (
                          <button
                            key={playlist.id}
                            data-tour-id={`app-playlist-option-${playlistTourSlug(playlist.name)}`}
                            type="button"
                            disabled={Boolean(applyingGenomePlaylistId)}
                            onClick={() => handleTopBarPlaylistSelect(playlist)}
                            className={`w-full px-4 py-3 text-left transition-colors border-b last:border-b-0 ${isLight
                              ? 'border-gray-100 hover:bg-blue-50 disabled:hover:bg-white'
                              : 'border-gray-800 hover:bg-blue-900/20 disabled:hover:bg-gray-900'
                            } ${isSelectedPlaylist ? (isLight ? 'bg-blue-50' : 'bg-blue-900/20') : ''}`}
                          >
                            <div className="flex items-center gap-2">
                              <div className="min-w-0 flex-1">
                                <div className={`text-sm font-semibold truncate ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>{playlist.name}</div>
                                <div className={`text-xs mt-0.5 ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                  {(playlist.genomes || []).length} genome{(playlist.genomes || []).length === 1 ? '' : 's'}
                                </div>
                              </div>
                              {isApplying ? (
                                <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                              ) : isSelectedPlaylist ? (
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className={isLight ? 'text-blue-600' : 'text-blue-300'}>
                                  <path d="M20 6 9 17l-5-5" />
                                </svg>
                              ) : null}
                            </div>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                  )}

                  {/* One tall arrow over whichever end the strip can still scroll to.
                      Drawn full height of the rows and stretched vertically, so it reads
                      as "the strip continues this way" rather than as another app
                      button. Overlaid, not placed beside the grid, so that appearing and
                      disappearing never moves the buttons. */}
                  {[
                    { side: 'left', show: topBarScroll.canLeft, dir: -1, points: '15 18 9 12 15 6', label: 'Scroll app buttons left' },
                    { side: 'right', show: topBarScroll.canRight, dir: 1, points: '9 18 15 12 9 6', label: 'Scroll app buttons right' },
                  ].filter((arrow) => arrow.show).map((arrow) => (
                    <button
                      key={arrow.side}
                      type="button"
                      onClick={() => scrollTopBarButtons(arrow.dir)}
                      className={`absolute inset-y-0 ${arrow.side === 'left' ? 'left-0' : 'right-0'} flex items-center justify-center text-[#0099ff] hover:text-[#0077cc] transition-colors cursor-pointer`}
                      style={{
                        width: TOP_BAR_SCROLL_ARROW_PX,
                        background: `linear-gradient(to ${arrow.side === 'left' ? 'right' : 'left'}, ${themeStyles.headerBgColor} 55%, ${themeStyles.headerBgFade})`,
                      }}
                      title={arrow.label}
                      aria-label={arrow.label}
                    >
                      <svg
                        width="18" height="40" viewBox="0 0 24 24" preserveAspectRatio="none"
                        fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
                      >
                        <polyline points={arrow.points} />
                      </svg>
                    </button>
                  ))}

                  {/* The organiser drawer. Anchored to the scroll viewport's own wrapper
                      and pulled out by its padding and border, so the preview grid inside
                      starts on exactly the same pixel as the real buttons above it and
                      each preview column sits under the button it stands for. `mt-3` is
                      the flex gap between the button rows and the pills strip, so the
                      drawer's header band starts where the strip starts, and its height
                      is the strip's height less this border — the two share a top and a
                      bottom edge. */}
                  <div
                    ref={appOrganiserPanelRef}
                    style={{
                      left: -(DRAWER_PADDING_X + DRAWER_BORDER_PX),
                      width: TOP_BAR_VIEWPORT_PX + 2 * (DRAWER_PADDING_X + DRAWER_BORDER_PX),
                    }}
                    className={`absolute top-full mt-3 origin-top-right rounded-xl border shadow-2xl z-50 transition-all duration-200 ${appOrganiserOpen
                      ? 'opacity-100 translate-y-0 pointer-events-auto'
                      : 'opacity-0 -translate-y-2 pointer-events-none'
                    } ${isLight ? 'bg-white border-gray-200 text-gray-900' : 'bg-gray-900 border-gray-700 text-gray-100'}`}
                  >
                    <div
                      className={`flex items-center border-b rounded-t-xl ${isLight ? 'border-gray-100 bg-gray-50' : 'border-gray-700 bg-gray-800'}`}
                      style={{
                        height: PILLS_STRIP_HEIGHT - DRAWER_BORDER_PX,
                        paddingLeft: DRAWER_PADDING_X,
                        paddingRight: DRAWER_PADDING_X,
                      }}
                    >
                      <div className="text-lg font-bold">Organise Apps</div>
                    </div>
                    <div
                      className="max-h-[60vh] overflow-y-auto themed-scrollbar py-4"
                      style={{ paddingLeft: DRAWER_PADDING_X, paddingRight: DRAWER_PADDING_X }}
                    >
                      <AppOrganiserPanel
                        theme={theme}
                        activeAppButtons={activeAppButtons}
                        onChange={handleAppOrganiserChange}
                        previewScrollRef={organiserScrollRef}
                      />
                    </div>
                  </div>
                  </div>

                  <div
                    className="flex flex-col gap-2 justify-end"
                    style={{
                      height: topBarButtonRows.length * TOP_BAR_BUTTON_PX
                        + Math.max(0, topBarButtonRows.length - 1) * TOP_BAR_GAP_PX,
                    }}
                  >
                    <div className="h-11 flex items-end">
                      <button
                        ref={appOrganiserButtonRef}
                        type="button"
                        onClick={() => {
                          if (!appOrganiserOpen) trackAchievement('organiser.opened')
                          setAppOrganiserOpen((prev) => !prev)
                        }}
                        className="w-6 h-6 rounded-md border-0 bg-transparent text-[#0099ff] flex items-center justify-center transition-colors hover:bg-[#0099ff]/10"
                        title={appOrganiserOpen ? 'Close the app organiser' : 'Organise apps'}
                        aria-label={appOrganiserOpen ? 'Close the app organiser' : 'Organise apps'}
                        aria-expanded={appOrganiserOpen}
                      >
                        <svg
                          width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                          strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round"
                          className={`transition-transform duration-200 ${appOrganiserOpen ? 'rotate-180' : ''}`}
                        >
                          <polyline points="6 9 12 15 18 9" />
                        </svg>
                      </button>
                    </div>
                  </div>

                </div>
                {/* Ensembl logo. Sized to the space left beside the app buttons rather
                    than to a round number: 80px is as tall as it can be without the mark
                    outgrowing the two button rows and pushing the header down. */}
                <img
                  src="ensembl-e-blue.svg"
                  alt="Ensembl"
                  className="h-20 self-center"
                />
              </div>
            )}

          </div>

          {showsPillsStrip && (
            <div
              data-tour-id="app-genome-pills"
              className={`border-t ${isLight ? 'border-gray-200' : 'border-gray-700'}`}
              style={{
                // A tutorial reserves this strip's place without showing anything in it,
                // so that ticking the first genome does not change the header height
                // under the rows being selected. That reservation stays blank; only the
                // ordinary empty app gets the message.
                visibility: (topBarSpecies.length === 0 && !showNoGenomesMessage) ? 'hidden' : undefined,
                backgroundColor: isLight ? '#f1f3f5' : '#1E2938',
                borderRadius: '0.5rem',
                paddingLeft: PILLS_STRIP_PADDING_X,
                paddingRight: PILLS_STRIP_PADDING_X,
                paddingTop: PILLS_STRIP_PADDING_TOP,
                paddingBottom: PILLS_STRIP_PADDING_BOTTOM,
              }}
            >
              <SelectedSpeciesPillsBar
                theme={theme}
                config={config}
                onToggleSpecies={currentView === 'structural_variation' ? handleStructuralVariationPillToggle : handleSpeciesPillToggle}
                onRemoveSpecies={handleRemoveSpeciesFromList}
                onReorderSpecies={handleSpeciesPillReorder}
                mode={topListMode}
                selectedSpeciesKeys={selectedSpeciesKeysForView}
                semiSelectedSpeciesKeys={semiSelectedSpeciesKeysForView}
                speciesList={topBarSpecies}
                primarySpeciesKey={speciesItemKey(refSpecies)}
                reserveRowHeight={reserveTutorialSelectorPills}
                emptyState={showNoGenomesMessage ? (
                  <NoGenomesPillsMessage isLight={isLight} onOpenView={handleTopBarButtonClick} />
                ) : null}
                trailing={(
                  <ActiveTasksButton
                    theme={theme}
                    onOpenDownloads={currentView === 'download' ? null : () => handleTopBarButtonClick('download')}
                  />
                )}
              />
            </div>
          )}

        </div>
      </header>

      {/* Main content container with flex-grow to fill remaining height */}
      <div
        ref={setMainContentNode}
        data-tutorial-page-scroll={['genome_selector', 'genome_browser'].includes(currentView) ? 'true' : undefined}
        className={`relative min-h-0 flex-grow w-full ${currentView === 'notes' ? 'py-6 pl-6 pr-0' : 'p-6'} ${(currentView === 'genome_browser' || currentView === 'alignment' || currentView === 'structural_variation' || currentView === 'genome_selector') ? `overflow-y-auto overflow-x-hidden themed-scrollbar ${isLight ? 'themed-scrollbar-light' : 'themed-scrollbar-dark'}` : 'overflow-hidden'}`}
      >
        {shouldRenderFallbackContentWrapper ? (
          <div ref={setActiveViewContentNode} className="h-full">
            {shouldShowWindowsBackendSetup ? (
            <WindowsBackendSetupView
              backendRuntime={backendRuntime}
              onClose={() => setBackendSetupOpen(false)}
              onRetryCheck={handleRetryBackendCheck}
              onRetryLaunch={handleRetryBackendLaunch}
            />
          ) : !configLoaded ? (
            <div className={`flex h-full items-center justify-center text-center ${isLight ? 'text-gray-600' : 'text-gray-300'}`} role="status" aria-live="polite">
              Loading saved configuration…
            </div>
          ) : currentView === 'home' ? (
            /* ========== HOME VIEW ========== */
            <div className="h-full">
              <HomeView
                theme={theme}
                onNavigate={(viewId) => setCurrentView(viewId)}
              />
            </div>
          ) : currentView === 'alignment' ? (
            /* ========== FEATURE ALIGNMENT VIEW ========== */
            <ErrorBoundary>
              <div data-screenshot-capture="view" className="min-h-full flex items-start gap-4">
              {/* Main content - Alignment area */}
              <div className="flex-1 min-w-0 flex flex-col">
                {alignmentViewError && (
                  <div className="bg-red-900/50 border border-red-700 rounded-lg p-4 mb-4 flex-none">
                    <p className="text-red-300">{alignmentViewError}</p>
                  </div>
                )}

                {alignmentViewLoading && (
                  <div className={`${themeStyles.panel} rounded-lg p-12 text-center flex-grow flex flex-col items-center justify-center`}>
                    <div className={`animate-spin w-8 h-8 border-4 ${isLight ? 'border-[#0099ff]' : 'border-blue-500'} border-t-transparent rounded-full mb-4`}></div>
                    <p className={themeStyles.subtext}>Running feature alignment...</p>
                  </div>
                )}

                {!alignmentViewLoading && !multiAlignmentResult && !alignmentViewError && (
                  <div className={`${themeStyles.panel} rounded-lg p-12 text-center flex-grow flex flex-col items-center justify-center`}>
                    <img
                      src="ensembl-e-blue.svg"
                      alt="Ensembl"
                      className="mb-4"
                      style={{
                        width: '160px',
                        height: '160px'
                      }}
                    />
                    <h2 className="text-xl font-semibold mb-2">No alignment loaded</h2>
                    <p className={themeStyles.subtext}>
                      {alignmentPreparedCount >= 2
                        ? 'Click Run alignment in the panel on the right to align the selected gene regions.'
                        : 'Search for genes here, or select genes in Genome Browser. At least two genomes are needed.'}
                    </p>
                  </div>
                )}

                {multiAlignmentResult && !alignmentViewLoading && (
                  <>
                    <MultiAlignmentPanel
                      key={alignmentViewerDisplayKey}
                      result={multiAlignmentResult ? { ...multiAlignmentResult, rows: alignmentDisplayRows } : multiAlignmentResult}
                      theme={theme}
                      collapseIntrons={collapseIntrons}
                      collapseSourceGenomeKey={collapseSource}
                      collapseSourceOptions={collapseSourceOptions}
                      onCollapseSourceChange={setCollapseSource}
                      onCollapseIntronsChange={setCollapseIntrons}
                    />
                    <div className="mt-4">
                      <FeatureLegend theme={theme} horizontal={true} defaultExpanded={true} />
                    </div>
                  </>
                )}
              </div>
              {/* Controls, on the right like the other views' drawers */}
              <div
                className="flex-shrink-0 self-start transition-[width] duration-300 ease-out"
                style={{ width: alignmentSidebarCollapsed ? '42px' : '360px' }}
              >
                <MultiAlignmentSidebar
                  theme={theme}
                  rows={alignmentInputs}
                  genomeColorsByKey={alignmentGenomeColorsByKey}
                  rowDisplayMetaByGenomeKey={alignmentDisplayMetaByGenomeKey}
                  globalFlanks={alignmentGlobalFlanks}
                  globalFlanksLocked={alignmentGlobalFlanksLocked}
                  globalFlankMax={alignmentGlobalFlankMax}
                  collapsed={alignmentSidebarCollapsed}
                  runSettings={alignmentRunSettings}
                  loading={alignmentViewLoading}
                  runDisabled={alignmentRunDisabled}
                  alignedGenomeCount={alignedGenomeCount}
                  unalignedGenomeCount={unalignedGenomeCount}
                  showUpdateNotice={alignmentNeedsRerun}
                  warnings={alignmentNeedsRerun ? [] : (multiAlignmentResult?.warnings || [])}
                  onSearchAll={handleAlignmentSearchAll}
                  onRowQueryChange={handleAlignmentRowQueryChange}
                  onResolveRow={handleAlignmentResolveRow}
                  onRowSettingChange={handleAlignmentRowSettingChange}
                  onGlobalFlanksChange={handleAlignmentGlobalFlanksChange}
                  onGlobalFlanksLockToggle={handleAlignmentGlobalFlanksLockToggle}
                  onGlobalFlankMaxChange={handleAlignmentGlobalFlankMaxChange}
                  onRunSettingsChange={handleAlignmentRunSettingsChange}
                  onRunAlignment={runMultiAlignment}
                  onSaveAlignment={handleSaveAlignment}
                  onLoadAlignment={() => setLoadAlignmentModalOpen(true)}
                  hasResult={Boolean(multiAlignmentResult)}
                  onToggleCollapsed={() => setAlignmentSidebarCollapsed((prev) => !prev)}
                />
              </div>

              </div>
            </ErrorBoundary>
          ) : currentView === 'sequence' ? (
            <ErrorBoundary><React.Suspense fallback={<div className="p-6 text-gray-400">Loading Sequence…</div>}><SequenceView theme={theme} config={config} genomes={config?.active_species || []} startingPoints={genomeStartingPoints} onGenomeChange={setSequenceGenomeKey} incoming={sequenceViewEntry} onIncomingConsumed={() => setSequenceViewEntry(null)} onFocusLocationSelect={handleGenomeFocusLocationSelect} onNavigateToBrowser={() => setCurrentView('genome_browser')} /></React.Suspense></ErrorBoundary>
          ) : currentView === 'alignment_explorer' ? (
            <ErrorBoundary><React.Suspense fallback={<div className="p-6 text-gray-400">Loading Alignment Explorer…</div>}><AlignmentExplorerView theme={theme} config={config} genomes={config?.active_species || []} topBarGenomes={topBarSpecies} onAddGenome={handleSpeciesPillToggle} incoming={explorerIncoming} onIncomingConsumed={() => setExplorerIncoming(null)} onOpenGenome={handleOpenAlignmentExplorerLoci} /></React.Suspense></ErrorBoundary>
          ) : currentView === 'gene_trees' ? (
            <ErrorBoundary><React.Suspense fallback={<div className="p-6 text-gray-400">Loading Gene Trees…</div>}><GeneTreesView theme={theme} config={config} genomes={config?.active_species || []} topBarGenomes={topBarSpecies} onAddGenome={handleSpeciesPillToggle} incoming={geneTreesIncoming} onIncomingConsumed={() => setGeneTreesIncoming(null)} /></React.Suspense></ErrorBoundary>
          ) : currentView === 'neighbourhood' ? (
            /* ========== NEIGHBOURHOOD VIEW ========== */
            <div className="h-full">
              <NeighbourhoodView
                theme={theme}
                config={config}
                genomes={neighbourhoodGenomes}
                disabledByGenome={neighbourhoodDisabledByGenome}
                focusGeneByGenome={focusGeneByGenome}
                queryByGenome={neighbourhoodQueryStateByGenome}
                trackByGenome={neighbourhoodTrackStateByGenome}
                linksByPair={neighbourhoodLinksByPair}
                loadingByGenome={neighbourhoodLoadingStateByGenome}
                errorByGenome={neighbourhoodErrorStateByGenome}
                onQueryChange={(genomeKey, value) => {
                  const key = String(genomeKey || '').trim()
                  if (!key) return
                  setNeighbourhoodQueryByGenome((prev) => ({ ...prev, [key]: value }))
                  setNeighbourhoodErrorByGenome((prev) => ({ ...prev, [key]: null }))
                }}
                onResolveGenome={handleNeighbourhoodResolveGenome}
                onSearchAll={handleNeighbourhoodSearchAll}
                onLinkSelect={handleNeighbourhoodLinkSelect}
                onFlipGenome={handleNeighbourhoodFlipGenome}
                onSwapAdjacent={handleNeighbourhoodSwapAdjacent}
                onToggleGenome={handleNeighbourhoodToggleGenome}
                useHomology={neighbourhoodUseHomology}
                homologyLinksByPair={neighbourhoodHomologyLinksByPair}
                homologyAvailabilityByGenome={neighbourhoodHomologyAvailabilityByGenome}
                homologyFilters={neighbourhoodHomologyFilters}
                homologyError={neighbourhoodHomologyError}
                onToggleUseHomology={handleNeighbourhoodUseHomologyClick}
                onHomologyFiltersChange={setNeighbourhoodHomologyFilters}
                homologyPairLoading={neighbourhoodHomologyPairLoading}
                noHitGenomeKeys={neighbourhoodNoHitGenomeKeys}
              />
            </div>
          ) : currentView === 'homology' ? (
            /* ========== HOMOLOGY VIEW ========== */
            <div className="h-full">
              <HomologyView
                theme={theme}
                config={config}
                genomes={homologyGenomes}
                localGenomes={homologyWorkspace.availableGenomes}
                workspace={homologyWorkspace}
                onToggleGenome={handleSpeciesPillToggle}
                onOpenGene={async (genome, gene) => {
                  const key = speciesItemKey(genome)
                  if (!key || !gene?.id) return
                  await handleGenomeWheelPromote(key, 'add', genome)
                  setBrowserGeneEntry({ genomeKey: key, gene })
                  setCurrentView('genome_browser')
                }}
              />
            </div>
          ) : currentView === 'feature_explorer' ? (
            /* ========== FEATURE EXPLORER VIEW ========== */
            <div className="h-full">
              <FeatureExplorerView
              key={featureExplorerActiveGenomeKey || 'feature-explorer-empty'}
              theme={theme}
              config={config}
              genomeKey={featureExplorerActiveGenomeKey}
              selectedGenome={featureExplorerActiveGenome}
              focusGene={featureExplorerActiveGenomeKey ? (focusGeneByGenome?.[featureExplorerActiveGenomeKey] || null) : null}
              seedQuery={featureExplorerSeedQuery}
              onFocusGene={(gene) => handleGenomeFocusGeneSelect(featureExplorerActiveGenomeKey, gene)}
              genomes={featureExplorerAvailableGenomes}
              focusGeneByGenome={focusGeneByGenome}
              onSelectGenome={handleFeatureExplorerGenomeSelect}
              screenshotMode={currentView === 'feature_explorer' ? screenshotMode : false}
              onScreenshotModeChange={setScreenshotMode}
              onScreenshotAvailabilityChange={handleScreenshotAvailabilityChange}
              screenshotToggleButtonRef={screenshotActionButtonRef}
              />
            </div>
          ) : currentView === 'stats' ? (
            /* ========== STATS VIEW ========== */
            <div className="h-full">
              <StatsView
                theme={theme}
                config={config}
                onConfigChange={handleConfigurationChange}
                listedGenomes={topBarSpecies}
                activeGenomeKeys={statsActiveGenomeKeys}
              />
            </div>
          ) : currentView === 'structural_variation' ? (
            /* ========== STRUCTURAL VARIATION VIEW ========== */
            <div className="min-h-full">
              <StructuralVariationView
                key={structuralVariationViewKey}
                theme={theme}
                config={config}
                refSpecies={svAnchorSpecies}
                tgtSpecies={svSecondSpecies}
                thirdSpecies={svThirdSpecies}
                activeSpecies={dedupeSpeciesList(config?.active_species || [])}
                inactiveSpecies={inactiveSelectedSpecies}
                thirdGenomeId={svThirdSpecies ? speciesItemKey(svThirdSpecies) : ''}
                refPillLabel={svAnchorPillLabel}
                tgtPillLabel={svSecondPillLabel}
                thirdPillLabel={svThirdPillLabel}
                onRefPillClick={() => svAnchorSpecies ? handleStructuralVariationPillToggle(svAnchorSpecies) : null}
                onTgtPillClick={() => svSecondSpecies ? handleStructuralVariationPillToggle(svSecondSpecies) : null}
                onThirdPillClick={() => svThirdSpecies ? handleStructuralVariationPillToggle(svThirdSpecies) : null}
                onGenomeOrderChange={handleStructuralVariationGenomeOrderChange}
                onAlignmentAvailabilityChange={handleSvAlignmentAvailabilityChange}
                selectedAnchorRegionId={svAnchorRegionId}
                regionExplicitlySelected={svRegionExplicitlySelected}
                onSelectedAnchorRegionIdChange={(nextRegionId, options = {}) => {
                  setSvAnchorRegionId(String(nextRegionId || ''))
                  setSvRegionExplicitlySelected(Boolean(options.explicit))
                }}
                onOpenGenomeSelector={() => setCurrentView('download')}
                browserRefGene={browserRefGene}
                browserRefViewport={browserRefViewport}
                savedViewportRef={svSavedViewportRef}
              />
            </div>
          ) : currentView === 'download' ? (
            /* ========== DOWNLOAD VIEW ========== */
            <div className="h-full">
              <DownloadView
                config={config}
                theme={theme}
                screenshotMode={currentView === 'download' ? screenshotMode : false}
                onScreenshotModeChange={setScreenshotMode}
                onScreenshotAvailabilityChange={handleScreenshotAvailabilityChange}
                screenshotToggleButtonRef={screenshotActionButtonRef}
              />
            </div>
          ) : currentView === 'genome_selector' ? (
            /* ========== GENOME SELECTOR VIEW ========== */
            <div className="min-h-full">
              <GenomeSelectorView
                config={selectorPlaylistConfig}
                onConfigChange={handleSelectorConfigChange}
                onToggleSpecies={handleSpeciesToggleFromSelector}
                onApplyPlaylist={handleApplyPlaylistFromSelector}
                selectedSpeciesList={selectorSelectedSpecies}
                tutorialListPresentation={tutorialRuntime.selectorListPresentation}
                tutorialDialogRequest={tutorialRuntime.dialogRequest}
                tutorialCustomGenomeRequest={tutorialRuntime.customGenomeRequest}
                theme={theme}
                screenshotMode={currentView === 'genome_selector' ? screenshotMode : false}
                onScreenshotModeChange={setScreenshotMode}
                onScreenshotAvailabilityChange={handleScreenshotAvailabilityChange}
                screenshotToggleButtonRef={screenshotActionButtonRef}
                scrollContainerNode={mainContentNode}
              />
            </div>
          ) : currentView === 'tutorials' ? (
            /* ========== TUTORIALS VIEW ========== */
            <div className="h-full">
              <TutorialsView
                theme={theme}
                config={config}
                onOpenConfiguration={() => setCurrentView('configuration')}
              />
            </div>
          ) : currentView === 'achievements' ? (
            /* ========== ACHIEVEMENTS VIEW ========== */
            <div className="h-full">
              <AchievementsView
                theme={theme}
                focusId={achievementFocusId}
                onFocusHandled={() => setAchievementFocusId('')}
              />
            </div>
          ) : currentView === 'help' ? (
            /* ========== HELP VIEW ========== */
            <div className="h-full">
              <HelpView
                theme={theme}
              />
            </div>
          ) : currentView === 'notes' ? (
            /* ========== NOTES VIEW ========== */
            <div className="h-full">
              <NotesView
                theme={theme}
                config={config}
                topBarSpecies={topBarSpecies}
                activeSpecies={dedupeSpeciesList(config?.active_species || [])}
                onGenomeFocusGeneSelect={handleGenomeFocusGeneSelect}
                onGenomeFocusLocationSelect={handleGenomeFocusLocationSelect}
                onNavigateToBrowser={() => setCurrentView('genome_browser')}
                onAddGenome={handleSpeciesPillToggle}
                onRedownloadGenome={() => setCurrentView('download')}
              />
            </div>
          ) : currentView === 'track_manager' ? (
            /* ========== TRACK MANAGER VIEW ========== */
            <div className="h-full">
              <TrackManagerView
                theme={theme}
                config={config}
                inactiveSpecies={inactiveSelectedSpecies}
                tutorialTrackRequest={tutorialRuntime.trackRequest}
                onTutorialTracksRegistered={tutorialRuntime.reportRegisteredTracks}
              />
            </div>
          ) : currentView === 'genome_browser' ? null : (
            /* ========== CONFIGURATION VIEW ========== */
            <ConfigurationView
              config={config}
              onConfigChange={handleConfigurationChange}
              onSave={handleConfigSaved}
              theme={theme}
            />
          )}
          </div>
        ) : null}

        {/* Genome Browser - always mounted, hidden when not active, to preserve state.
            Only render after config has loaded so browsers fetch the correct genome data. */}
        {!shouldShowWindowsBackendSetup && configLoaded && (
          <div className="w-full h-full" style={{ display: currentView === 'genome_browser' ? 'block' : 'none' }}>
            <ErrorBoundary>
              <GenomeBrowserView
                listedGenomes={topBarSpecies}
                onPromoteGenome={handleGenomeWheelPromote}
                theme={theme}
                config={config}
                isActive={currentView === 'genome_browser'}
                allowBackgroundPrep={currentView !== 'download'}
                alignmentOverlay={null}
                onClearAlignmentOverlay={() => { }}
                onRefGeneSelect={handleRefGeneSelect}
                onTgtGeneSelect={handleTgtGeneSelect}
                onRefViewportChange={reportBrowserRefViewport}
                refReloadKey={refBrowserReloadKey}
                tgtReloadKey={tgtBrowserReloadKey}
                externalRefGene={browserRefGene}
                externalTgtGene={browserTgtGene}
                externalFocusGenesByGenome={focusGeneByGenome}
                externalFocusLocationsByGenome={browserLocationFocusByGenome}
                incomingGene={browserGeneEntry}
                onIncomingGeneConsumed={handleBrowserGeneEntryConsumed}
                onGeneFocusByGenomeChange={setBrowserFocusByGenome}
                onClearFocusedGenes={handleClearAllFocusedGenes}
                screenshotMode={currentView === 'genome_browser' ? screenshotMode : false}
                onScreenshotModeChange={setScreenshotMode}
                onScreenshotAvailabilityChange={handleScreenshotAvailabilityChange}
                screenshotToggleButtonRef={screenshotActionButtonRef}
              />
            </ErrorBoundary>
          </div>
        )}

        <ScreenshotSelectionOverlay
          active={usingFallbackScreenshot && Boolean(fallbackScreenshotTarget)}
          theme={theme}
          containerRef={fallbackScreenshotOverlayRef}
          scrollContainerRef={fallbackScreenshotOverlayRef}
          targets={fallbackScreenshotTargets}
          instructions="Click on the highlighted area to export"
          highlightSingleTarget={true}
          selectSingleTargetOnClick={true}
          onSelect={(target) => {
            setSelectedFallbackScreenshotTarget(target)
            setScreenshotMode(false)
          }}
          onCancel={() => {
            setScreenshotMode(false)
            setSelectedFallbackScreenshotTarget(null)
          }}
        />
      </div>

      {/* ── Alignment save/load modals ────────────────────────────────── */}
      {saveAlignmentModalOpen && (
        <SaveAlignmentModal
          open={saveAlignmentModalOpen}
          theme={theme}
          result={multiAlignmentResult}
          activeSpeciesByKey={activeSpeciesByKey}
          onSave={handleDoSaveAlignment}
          onClose={() => setSaveAlignmentModalOpen(false)}
        />
      )}
      {loadAlignmentModalOpen && (
        <LoadAlignmentModal
          open={loadAlignmentModalOpen}
          theme={theme}
          apiBase={API_BASE}
          outputDir={config?.output_dir || ''}
          activeGenomes={dedupeSpeciesList(config?.active_species || [])}
          inactiveGenomes={dedupeSpeciesList(inactiveSelectedSpecies)}
          onLoad={handleLoadAlignment}
          onClose={() => setLoadAlignmentModalOpen(false)}
        />
      )}
      <AchievementToastHost
        isLight={isLight}
        onOpen={(achievementId) => {
          setAchievementFocusId(achievementId || '')
          handleTopBarButtonClick('achievements')
        }}
      />
      <ScreenshotExportModal
        open={Boolean(selectedFallbackScreenshotTarget)}
        theme={theme}
        target={selectedFallbackScreenshotTarget}
        outputDir={defaultFallbackScreenshotDir}
        onSave={handleFallbackScreenshotSave}
        onClose={handleFallbackScreenshotModalClose}
      />
      {outputDirNotification && (
        <div
          role="status"
          data-output-dir-notification="true"
          data-tutorial-notification="true"
          aria-live="polite"
          className="fixed right-4 top-24 z-50 max-w-[calc(100vw-32px)] break-words rounded-lg border border-emerald-400 bg-emerald-500/90 px-6 py-4 text-white shadow-lg backdrop-blur-sm sm:right-6 sm:max-w-md"
        >
          <div className="flex items-start gap-3">
            <svg
              className="mt-0.5 shrink-0"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" strokeLinecap="round" strokeLinejoin="round" />
              <polyline points="22 4 12 14.01 9 11.01" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="min-w-0 font-medium break-words">
              Output directory set: <span className="font-mono">{outputDirNotification}</span>
            </span>
          </div>
        </div>
      )}
      <GettingStartedOutputDirPrompt
        open={Boolean(
          configLoaded &&
          currentView === 'home' &&
          !String(userConfig?.output_dir || '').trim() &&
          !gettingStartedOutputDirDismissed &&
          !shouldShowWindowsBackendSetup &&
          !tutorialRuntime.isRunning
        )}
        outputDir={userConfig?.output_dir || ''}
        workingDir={userConfig?.working_dir || ''}
        theme={theme}
        onSave={handleGettingStartedOutputDir}
        onSkip={() => setGettingStartedOutputDirDismissed(true)}
      />
    </div >
    )
}

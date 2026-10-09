// The toolbar of a Genome Browser panel: genome pill, region picker, location
// search, and the focus, transcript, track, ruler, flip and selection controls.
// Rendered by the panel (a plain call, not a separate component).
import { browserControlKey } from '../../achievements/browserControls.js'
import { trackAchievement } from '../../achievements/tracker.js'
import InfoGlyph from '../InfoGlyph'
import { formatBp, formatCoord } from './browserFormat.js'

export function renderBrowserToolbar(ctx) {
    const {
        RESET_ICON_PATH_D,
        chromLabel,
        colors,
        controlAccentColor,
        effectiveToolbarPosition,
        focusCurrentWindow,
        genes,
        genome,
        genomePillExpanded,
        genomePillLabel,
        handleRegionChange,
        handleSearch,
        isBoxSelectMode,
        isFlipped,
        isLight,
        isLocationFocusVisible,
        isPrimaryPanel,
        isRulerCollapsed,
        isTranscriptCompressionActive,
        isVerticalLayoutFlipped,
        isViewportTranscriptExpandMode,
        onGenomePillClick,
        panelPillColor,
        refreshAvailableTracks,
        screenshotTargetId,
        searchFeedback,
        searchInput,
        selectedChrom,
        selectedGene,
        setExpandedGenes,
        setIsBoxSelectMode,
        setIsRulerCollapsed,
        setIsSelectingRect,
        setIsTrackPickerOpen,
        setIsVerticalLayoutFlipped,
        setIsViewportTranscriptExpandMode,
        setSearchInput,
        setSelectedTrackPickerIds,
        setSelectionRect,
        setShowFeatureless,
        showFeatureless,
        showSearchFeedback,
        sortedRegions,
        toggleFlipped,
        toolbarColumnWidths,
        toolbarRef,
        viewEnd,
        viewStart,
    } = ctx
    return (
<div
            ref={toolbarRef}
            data-browser-controls="true"
            // The assembly drawer lines its header band up with this row, so the
            // drawer reads as sliding out of the genome pill that opened it.
            data-browser-toolbar="true"
            data-browser-toolbar-position={effectiveToolbarPosition}
            data-focus-panel-key={screenshotTargetId || genome}
            // Control freak counts this genome's toolbar as well as the general control
            // bar; see achievements/browserControls.js.
            onClickCapture={(event) => {
                const key = browserControlKey(event.target)
                if (key) trackAchievement('browser.control', key)
            }}
            onKeyDownCapture={(event) => {
                if (event.key === 'Enter' && event.target?.dataset?.tourId === 'browser-location-search') {
                    trackAchievement('browser.control', 'browser-location-search-go')
                }
            }}
            className="flex items-center gap-0 px-3 py-2 border-b flex-none"
            style={{
                backgroundColor: colors.infoBg,
                borderColor: isLight ? '#dee2e6' : '#373a40',
            }}
        >
            {genomePillLabel && (
                <button
                    type="button"
                    data-browser-control="browser-genome-pill"
                    onClick={() => {
                        if (!onGenomePillClick) return
                        if (!genomePillExpanded) trackAchievement('browser.pillInfo')
                        onGenomePillClick()
                    }}
                    disabled={!onGenomePillClick}
                    className="inline-flex items-center rounded-full border px-3 py-1.5 text-xs font-medium mr-2 shrink-0"
                    style={{
                        backgroundColor: panelPillColor,
                        color: '#ffffff',
                        borderColor: 'transparent',
                        opacity: onGenomePillClick ? 1 : 0.9,
                        cursor: onGenomePillClick ? 'pointer' : 'default',
                        width: `${toolbarColumnWidths.genome}px`,
                    }}
                    title={onGenomePillClick ? `${genomePillLabel} (click for assembly information)` : genomePillLabel}
                    aria-expanded={genomePillExpanded}
                >
                    <span className="truncate">{genomePillLabel}</span>
                    {/* Marks the pill as something to read, not just a label.
                        Only where there is something behind it to open. */}
                    {onGenomePillClick && (
                        <span className="ml-auto flex-none pl-1.5 opacity-90">
                            <InfoGlyph size={13} strokeWidth={2.2} />
                        </span>
                    )}
                </button>
            )}

            {/* Region selector */}
            <select
                data-tour-id="browser-region-select"
                value={selectedChrom}
                onChange={(e) => {
                    const v = e.target.value
                    if (v === '__show_featureless__') {
                        setShowFeatureless(true)
                        return
                    }
                    handleRegionChange(v)
                }}
                className="text-xs px-2 py-1 rounded border"
                style={{
                    backgroundColor: colors.bg,
                    color: colors.infoText,
                    borderColor: isLight ? '#ced4da' : '#495057',
                    width: `${toolbarColumnWidths.region}px`,
                    flex: `0 0 ${toolbarColumnWidths.region}px`,
                }}
            >
                {sortedRegions.withFeatures.map(r => (
                    <option key={r.chrom} value={r.chrom}>
                        {r.display_name || r.chrom} ({r.gene_count} genes, {formatBp(r.length)})
                    </option>
                ))}
                {sortedRegions.featureless.length > 0 && !showFeatureless && (
                    <option value="__show_featureless__" style={{ fontStyle: 'italic', opacity: 0.7 }}>
                        + {sortedRegions.featureless.length} featureless region{sortedRegions.featureless.length !== 1 ? 's' : ''}
                    </option>
                )}
                {showFeatureless && sortedRegions.featureless.map(r => (
                    <option key={r.chrom} value={r.chrom}>
                        {r.display_name || r.chrom} (no genes, {formatBp(r.length)})
                    </option>
                ))}
            </select>

            {/* Search. The wrapper is anchored as well as the input: the box and its go
                button are one control to a reader, so a tutorial spotlighting the pair
                leaves the button inside the lit, clickable area rather than dimmed
                alongside the field it belongs to. */}
            <div
                data-tour-id="browser-location-search-field"
                className="relative flex items-center gap-0.5 ml-2 mr-0.5 shrink-0"
                style={{ width: `${toolbarColumnWidths.search}px` }}
            >
                <input
                    data-tour-id="browser-location-search"
                    type="text"
                    value={searchInput}
                    onChange={(e) => {
                        setSearchInput(e.target.value)
                        if (searchFeedback) showSearchFeedback(null)
                    }}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') handleSearch()
                        else if (e.key === 'Escape' && searchFeedback) showSearchFeedback(null)
                    }}
                    placeholder="Gene name or chr:start-end"
                    aria-invalid={searchFeedback?.tone === 'error' ? 'true' : undefined}
                    aria-describedby={searchFeedback ? `${screenshotTargetId || 'browser'}-search-feedback` : undefined}
                    className="text-xs px-2 py-1 rounded border flex-1 min-w-0"
                    style={{
                        backgroundColor: colors.bg,
                        color: colors.infoText,
                        borderColor: searchFeedback?.tone === 'error'
                            ? (isLight ? '#dc2626' : '#f87171')
                            : (isLight ? '#ced4da' : '#495057'),
                    }}
                />
                {searchFeedback && (
                    <div
                        id={`${screenshotTargetId || 'browser'}-search-feedback`}
                        data-tour-id="browser-location-search-feedback"
                        role={searchFeedback.tone === 'error' ? 'alert' : 'status'}
                        className="absolute left-0 top-full mt-1 z-40 flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-[11px] leading-snug shadow-lg"
                        style={{
                            width: 'max(100%, 340px)',
                            backgroundColor: searchFeedback.tone === 'error'
                                ? (isLight ? '#fef2f2' : '#3b1219')
                                : (isLight ? '#fffbeb' : '#3a2a0a'),
                            borderColor: searchFeedback.tone === 'error'
                                ? (isLight ? '#fca5a5' : '#7f1d1d')
                                : (isLight ? '#fcd34d' : '#78350f'),
                            color: searchFeedback.tone === 'error'
                                ? (isLight ? '#991b1b' : '#fecaca')
                                : (isLight ? '#92400e' : '#fde68a'),
                        }}
                    >
                        <span className="flex-1">{searchFeedback.text}</span>
                        <button
                            type="button"
                            onClick={() => showSearchFeedback(null)}
                            aria-label="Dismiss"
                            className="shrink-0 opacity-70 hover:opacity-100"
                        >✕</button>
                    </div>
                )}
                <button
                    data-tour-id="browser-location-search-go"
                    onClick={handleSearch}
                    className="p-1 rounded transition-opacity hover:opacity-80 flex items-center justify-center"
                    style={{ backgroundColor: controlAccentColor, color: '#ffffff', width: '28px', height: '28px' }}
                    title="Go to location"
                >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="11" cy="11" r="8"></circle>
                        <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                    </svg>
                </button>
            </div>

            {/* View Controls Group */}
            <div
                className="flex items-center gap-1.5 ml-0 pl-0.5 border-l border-gray-300 dark:border-gray-700 shrink-0"
                style={{ width: `${toolbarColumnWidths.iconGroup}px` }}
            >

                {/* Focus this window — the location counterpart of clicking a gene */}
                <button
                    data-tour-id="browser-focus-window"
                    data-tutorial-engaged={isLocationFocusVisible ? 'true' : 'false'}
                    onClick={() => {
                        trackAchievement('browser.locationFocus')
                        focusCurrentWindow()
                    }}
                    disabled={!selectedChrom}
                    className="p-1.5 rounded transition-opacity hover:opacity-80 disabled:opacity-50 flex items-center justify-center"
                    style={{
                        backgroundColor: controlAccentColor,
                        color: '#ffffff',
                        width: '32px', height: '28px',
                        boxShadow: isLocationFocusVisible ? `0 0 0 2px ${isLight ? '#ffffff' : '#111827'} inset` : 'none',
                    }}
                    title={selectedGene
                        ? 'Focus the current window instead of the gene of focus'
                        : 'Make the current window the location of focus'}
                >
                    <svg width="19" height="19" viewBox="0 0 32 32" fill="none" aria-hidden="true">
                        <path d={RESET_ICON_PATH_D} fill="currentColor" />
                    </svg>
                </button>

                {/* Expand / Collapse All — single toggle */}
                {(() => {
                    const isWindowExpanded = isViewportTranscriptExpandMode
                    const transcriptControlsDisabled = isTranscriptCompressionActive

                    return (
                        <button
                            data-tour-id="browser-expand-transcripts"
                            data-tutorial-engaged={isWindowExpanded ? 'true' : 'false'}
                            onClick={() => {
                                if (transcriptControlsDisabled) return
                                if (isWindowExpanded) {
                                    setIsViewportTranscriptExpandMode(false)
                                    setExpandedGenes({})
                                } else {
                                    setIsViewportTranscriptExpandMode(true)
                                }
                            }}
                            className="p-1.5 rounded transition-opacity hover:opacity-80 disabled:opacity-50 flex items-center justify-center"
                            disabled={transcriptControlsDisabled || (!isWindowExpanded && genes.length === 0)}
                            style={{
                                backgroundColor: transcriptControlsDisabled
                                    ? (isLight ? '#e5e7eb' : '#374151')
                                    : controlAccentColor,
                                color: transcriptControlsDisabled
                                    ? (isLight ? '#9ca3af' : '#6b7280')
                                    : '#ffffff',
                                width: '32px', height: '28px'
                            }}
                            title={transcriptControlsDisabled
                                ? 'Disable Compress to change transcript expansion'
                                : (isWindowExpanded
                                    ? 'Return to canonical transcripts'
                                    : 'Expand transcripts in the current window and surrounding buffer')}
                        >
                            {/* Make SVG use the full 24x24 canvas to expand the diagram's visual size */}
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                {isWindowExpanded ? (
                                    <>
                                        {/* Top transcript */}
                                        <line x1="2" y1="5" x2="22" y2="5" strokeWidth="1" />
                                        <rect x="2" y="3" width="5" height="4" fill="currentColor" stroke="none" />
                                        <rect x="10" y="3" width="6" height="4" fill="currentColor" stroke="none" />
                                        <rect x="19" y="3" width="3" height="4" fill="currentColor" stroke="none" />
                                        {/* Up arrow */}
                                        <path d="M12 21V10" strokeWidth="3" />
                                        <path d="M8 14l4-4 4 4" strokeWidth="3" fill="none" />
                                    </>
                                ) : (
                                    <>
                                        {/* Transcript 1 (top): 3 exons */}
                                        <line x1="2" y1="4" x2="22" y2="4" strokeWidth="1" />
                                        <rect x="2" y="2" width="5" height="4" fill="currentColor" stroke="none" />
                                        <rect x="10" y="2" width="6" height="4" fill="currentColor" stroke="none" />
                                        <rect x="19" y="2" width="3" height="4" fill="currentColor" stroke="none" />

                                        {/* Transcript 2 (middle): 2 exons skipping middle */}
                                        <line x1="2" y1="12" x2="22" y2="12" strokeWidth="1" />
                                        <rect x="2" y="10" width="5" height="4" fill="currentColor" stroke="none" />
                                        <rect x="19" y="10" width="3" height="4" fill="currentColor" stroke="none" />

                                        {/* Transcript 3 (bottom): 1 long exon (aligned left but not full width) */}
                                        {/* Fits the first two exons horizontally to show alternative transcript splicing */}
                                        <rect x="2" y="18" width="14" height="4" fill="currentColor" stroke="none" />
                                    </>
                                )}
                            </svg>
                        </button>
                    )
                })()}

                {/* Flip Track Orientation */}
                <button
                    data-browser-control="browser-flip"
                    data-tutorial-engaged={isFlipped ? 'true' : 'false'}
                    onClick={toggleFlipped}
                    className={`p-1.5 rounded transition-opacity flex items-center justify-center hover:opacity-80`}
                    style={{
                        backgroundColor: controlAccentColor,
                        color: '#ffffff',
                        width: '32px', height: '28px',
                        // The same pressed ring the focus-window button wears.
                        boxShadow: isFlipped ? `0 0 0 2px ${isLight ? '#ffffff' : '#111827'} inset` : 'none',
                    }}
                    aria-pressed={isFlipped}
                    title={isFlipped
                        ? "Reverse complement mode is active. Click to restore 5' to 3'"
                        : "Flip to 3' to 5' view (reverse complement)"}
                >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 9a9 9 0 0 0-14.8-4.2L3 8" />
                        <path d="M3 3v5h5" />
                        <path d="M3 15a9 9 0 0 0 14.8 4.2l3.2-3.2" />
                        <path d="M21 21v-5h-5" />
                        {/* Strikethrough when flipped */}
                        {isFlipped && (
                            <line x1="2" y1="2" x2="22" y2="22" stroke="white" strokeWidth="3" />
                        )}
                    </svg>
                </button>

                {/* Flip Vertical Track Layout (Primary/Secondary preset style) */}
                <button
                    data-browser-control="browser-strand-layout"
                    onClick={() => setIsVerticalLayoutFlipped((prev) => !prev)}
                    className="p-1.5 rounded transition-opacity flex items-center justify-center hover:opacity-80"
                    style={{
                        backgroundColor: controlAccentColor,
                        color: '#ffffff',
                        width: '32px', height: '28px',
                        boxShadow: 'none',
                    }}
                    title={`Switch to ${isVerticalLayoutFlipped
                        ? (isPrimaryPanel ? 'primary' : 'secondary')
                        : (isPrimaryPanel ? 'secondary' : 'primary')
                        } layout style`}
                >
                    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M8 20V5" />
                        <path d="M4.5 8.5L8 5l3.5 3.5" />
                        <path d="M16 4v15" />
                        <path d="M12.5 15.5L16 19l3.5-3.5" />
                    </svg>
                </button>

                {/* Box-Select Zoom */}
                <button
                    data-browser-control="browser-box-zoom"
                    onClick={() => {
                        setIsBoxSelectMode(prev => !prev)
                        setIsSelectingRect(false)
                        setSelectionRect(null)
                    }}
                    className="p-1.5 rounded transition-opacity flex items-center justify-center hover:opacity-80"
                    style={{
                        backgroundColor: controlAccentColor,
                        color: '#ffffff',
                        width: '32px', height: '28px',
                        boxShadow: isBoxSelectMode ? `0 0 0 2px ${isLight ? '#ffffff' : '#111827'} inset` : 'none'
                    }}
                    title={isBoxSelectMode ? 'Selection mode active: drag to zoom' : 'Activate selection zoom mode'}
                >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="2.5" y="2.5" width="16" height="16" rx="2.2" strokeWidth="2.2" strokeDasharray="3.2 2.2" />
                        <path d="M21 16.8v5.2M18.4 19.4h5.2" strokeWidth="2.2" />
                    </svg>
                </button>

                {/* Add Custom Track — opens Track Picker (shows registered tracks) */}
                <button
                    data-tour-id="browser-add-track"
                    onClick={() => {
                        refreshAvailableTracks?.()
                        setSelectedTrackPickerIds([])
                        setIsTrackPickerOpen(true)
                    }}
                    className="p-1.5 rounded transition-opacity flex items-center justify-center hover:opacity-80"
                    style={{
                        backgroundColor: controlAccentColor,
                        color: '#ffffff',
                        width: '32px', height: '28px'
                    }}
                    title="Add Custom Track"
                >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 6h6" strokeWidth="2.1" />
                        <path d="M3 12h10" strokeWidth="2.1" />
                        <path d="M3 18h14" strokeWidth="2.1" />
                        <path d="M16 4v6" strokeWidth="2.1" />
                        <path d="M13 7h6" strokeWidth="2.1" />
                    </svg>
                </button>
            </div>

            {/* Coordinates display */}
            <button
                data-tour-id="browser-coordinates"
                type="button"
                onClick={() => setIsRulerCollapsed((prev) => !prev)}
                className="text-xs ml-auto tabular-nums rounded px-1.5 py-1 transition-colors hover:bg-black/5 dark:hover:bg-white/10 text-right truncate shrink-0"
                style={{
                    color: colors.rulerText,
                    width: `${toolbarColumnWidths.coordinates}px`,
                }}
                title={isRulerCollapsed ? 'Show coordinate ruler' : 'Hide coordinate ruler'}
                aria-pressed={isRulerCollapsed}
            >
                {chromLabel(selectedChrom)}:{formatCoord(Math.floor(viewStart))}-{formatCoord(Math.ceil(viewEnd))} ({formatBp(Math.ceil(viewEnd - viewStart))})
            </button>
        </div>
    )
}

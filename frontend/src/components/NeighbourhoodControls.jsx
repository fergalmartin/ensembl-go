import { useState } from 'react'
import { genomePillColors } from '../utils/genomePillColors'
import DrawerChevron from './DrawerChevron'
import { DrawerIconButton, DrawerSectionHeading, VerticalChevronGlyph } from './focusDrawerChrome'
import { focusDrawerPalette } from './focusDrawerStyle'

// Neighbourhood's controls, as a drawer on the right of the view in the same chrome
// as Feature Alignment's: a band with the collapse arrow, a search across every
// genome, then each genome as a row rather than a card. The swap between two
// neighbouring genomes sits on the rule that separates their rows.
//
// It is part of the view rather than a panel beside it: it runs the full height of
// the view against the track, and its band takes the height of the track's control
// bar so the two read as one band across the top.

/** Reverse the row: 5' to 3' becomes 3' to 5'. Struck through while it is flipped. */
function FlipGlyph({ flipped, size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 9a9 9 0 0 0-14.8-4.2L3 8" />
      <path d="M3 3v5h5" />
      <path d="M3 15a9 9 0 0 0 14.8 4.2l3.2-3.2" />
      <path d="M21 21v-5h-5" />
      {flipped && <line x1="2" y1="2" x2="22" y2="22" strokeWidth="2.4" />}
    </svg>
  )
}

function SwapGlyph({ size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 20V5" />
      <path d="M4.5 8.5L8 5l3.5 3.5" />
      <path d="M16 4v15" />
      <path d="M12.5 15.5L16 19l3.5-3.5" />
    </svg>
  )
}

export default function NeighbourhoodControls({
  theme = 'dark',
  bandHeight = 48,
  rows = [],
  resolveGenomeColor,
  queryByGenome = {},
  loadingByGenome = {},
  errorByGenome = {},
  flippedByGenome = {},
  loadedCount = 0,
  useHomology = false,
  homologyAvailabilityByGenome = {},
  collapsed = false,
  onToggleCollapsed,
  onSearchAll,
  onQueryChange,
  onResolveGenome,
  onToggleGenome,
  onToggleFlip,
  onSwapAdjacent,
}) {
  const isLight = theme === 'light'
  const palette = focusDrawerPalette(isLight)
  // Edged in the track's own rule colour, so the line down the side and the line
  // under the band carry on from the ones in the track.
  const drawerStyle = { backgroundColor: palette.surface.backgroundColor, borderColor: palette.divider }
  const bandStyle = { ...palette.band, height: bandHeight, borderBottom: `1px solid ${palette.divider}` }
  const [sharedQuery, setSharedQuery] = useState('')
  const [genomesOpen, setGenomesOpen] = useState(true)

  const inputClass = isLight
    ? 'bg-gray-50 border-gray-300 text-gray-900 placeholder-gray-400 focus:ring-blue-500 focus:border-blue-500'
    : 'bg-gray-700 border-gray-600 text-white placeholder-gray-500 focus:ring-blue-500'
  const goButtonClass = 'px-2 py-1.5 rounded text-xs text-white bg-[#0099ff] hover:bg-[#0088ee] disabled:bg-gray-500 disabled:cursor-not-allowed'

  const toggleButton = (
    <DrawerIconButton
      onClick={() => onToggleCollapsed?.()}
      title={collapsed ? 'Show neighbourhood controls' : 'Hide neighbourhood controls'}
      accent={palette.accent}
      rowHoverClass={palette.rowHoverClass}
      expanded={!collapsed}
    >
      <DrawerChevron pointsRight={!collapsed} size={20} />
    </DrawerIconButton>
  )

  if (collapsed) {
    return (
      <div className="h-full border-l overflow-hidden flex flex-col" style={drawerStyle}>
        <div className="flex-none flex items-center justify-center" style={bandStyle}>
          {toggleButton}
        </div>
      </div>
    )
  }

  const enabledCount = rows.filter((row) => !row.isDisabled).length
  const hiddenCount = rows.length - enabledCount
  // Searching every genome only means something once there is more than one.
  const showSearchAll = rows.length > 1
  const canSearchAll = Boolean(sharedQuery.trim()) && enabledCount > 0

  return (
    <div className="h-full min-h-0 border-l overflow-hidden flex flex-col" style={drawerStyle}>
      <div className="flex-none flex items-center gap-2 pl-1 pr-3" style={bandStyle}>
        {toggleButton}
        <div className="min-w-0">
          <div className="text-sm font-semibold leading-tight">Neighbourhood</div>
          <div className="text-[11px] leading-tight opacity-75">
            {`${loadedCount} of ${enabledCount} genome${enabledCount === 1 ? '' : 's'} loaded`}
            {hiddenCount > 0 ? ` · ${hiddenCount} hidden` : ''}
          </div>
        </div>
      </div>

      {/* One gene for every genome, the way Feature Alignment and Homology search them all. */}
      {showSearchAll && (
        <form
          className="flex-none flex gap-2 px-3 pt-3 pb-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (canSearchAll) onSearchAll?.(sharedQuery.trim())
          }}
        >
          <input
            type="text"
            value={sharedQuery}
            onChange={(event) => setSharedQuery(event.target.value)}
            placeholder="Gene symbol or ID across all genomes"
            aria-label="Gene symbol or ID across all genomes"
            className={`flex-1 min-w-0 ${inputClass} border rounded px-2 py-1.5 text-xs`}
          />
          <button
            type="submit"
            disabled={!canSearchAll}
            className="px-3 py-1.5 rounded text-xs font-medium text-white bg-[#0099ff] hover:bg-[#0088ee] disabled:bg-gray-500 disabled:cursor-not-allowed whitespace-nowrap"
          >
            Search all
          </button>
        </form>
      )}

      <div className="flex-none pt-1">
        <DrawerSectionHeading label="Genomes" count={rows.length} divider={palette.divider} subTextClass={palette.subTextClass}>
          <DrawerIconButton
            onClick={() => setGenomesOpen((prev) => !prev)}
            title={genomesOpen ? 'Collapse genomes' : 'Expand genomes'}
            accent={palette.accent}
            rowHoverClass={palette.rowHoverClass}
            expanded={genomesOpen}
            compact
          ><VerticalChevronGlyph pointsDown={!genomesOpen} size={17} /></DrawerIconButton>
        </DrawerSectionHeading>
      </div>

      {genomesOpen && (
        <div className="min-h-0 overflow-y-auto pb-1">
          {rows.map((row, idx) => {
            const key = row.genomeKey
            const query = String(queryByGenome?.[key] || '')
            const isLoading = Boolean(loadingByGenome?.[key])
            const rowError = String(errorByGenome?.[key] || '')
            const isDisabled = Boolean(row.isDisabled)
            const isFlipped = Boolean(flippedByGenome?.[key])
            const label = row.label
            const pillColors = genomePillColors(resolveGenomeColor(row.species), {
              isLight,
              state: isDisabled ? 'inactive' : 'active',
            })
            const previousRow = idx > 0 ? rows[idx - 1] : null
            return (
              <div
                key={key}
                className={`relative px-3 py-2.5 space-y-2 ${idx > 0 ? 'border-t' : ''}`}
                style={{ borderColor: palette.divider }}
              >
                {previousRow && (
                  <button
                    type="button"
                    onClick={() => onSwapAdjacent?.(previousRow.genomeKey, key)}
                    title="Swap these two genomes"
                    aria-label="Swap these two genomes"
                    className={`absolute left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 z-10 flex items-center justify-center rounded border transition-colors ${palette.rowHoverClass}`}
                    style={{ width: 28, height: 18, color: palette.accent, backgroundColor: palette.surface.backgroundColor, borderColor: palette.divider }}
                  >
                    <SwapGlyph size={14} />
                  </button>
                )}

                <div className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => onToggleGenome?.(key)}
                    className="inline-flex items-center h-6 min-w-0 max-w-[260px] px-2.5 text-xs font-medium rounded-full border"
                    style={{
                      backgroundColor: pillColors.backgroundColor,
                      color: pillColors.textColor,
                      borderColor: pillColors.borderColor,
                    }}
                    title={isDisabled ? `Show ${label} in the neighbourhood` : `Hide ${label} from the neighbourhood`}
                  >
                    <span className="truncate">{label}</span>
                  </button>
                  {!isDisabled && (
                    <DrawerIconButton
                      onClick={() => onToggleFlip?.(key)}
                      title={isFlipped ? "Restore 5' to 3'" : "Flip 3' to 5'"}
                      accent={palette.accent}
                      rowHoverClass={palette.rowHoverClass}
                      compact
                    ><FlipGlyph flipped={isFlipped} size={16} /></DrawerIconButton>
                  )}
                </div>

                {!isDisabled && (
                  <form
                    className="flex gap-2"
                    onSubmit={(event) => {
                      event.preventDefault()
                      onResolveGenome?.(key)
                    }}
                  >
                    <input
                      type="text"
                      value={query}
                      onChange={(event) => onQueryChange?.(key, event.target.value)}
                      placeholder="Gene symbol or gene/transcript ID"
                      className={`flex-1 min-w-0 ${inputClass} border rounded px-2 py-1.5 text-xs`}
                    />
                    <button type="submit" disabled={isLoading || !query.trim()} className={goButtonClass}>
                      {isLoading ? (
                        <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-label="Loading">
                          <path d="M20 12a8 8 0 1 1-2.34-5.66" />
                          <path d="M20 4v5h-5" />
                        </svg>
                      ) : 'Go'}
                    </button>
                  </form>
                )}

                {!isDisabled && rowError && <div className="text-[11px] text-red-400">{rowError}</div>}
                {!isDisabled && useHomology && homologyAvailabilityByGenome?.[key] === 'unavailable' && (
                  <div className={`text-[11px] ${isLight ? 'text-amber-600' : 'text-amber-400'}`}>No homology data published for this genome</div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

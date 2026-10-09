import { useMemo, useState } from 'react'
import { buildAvailableSvAlignmentRows } from '../../utils/svCatalog.js'
import { getSpeciesDisplayName, getSvCatalogGenomeDisplayName, getSvGenomeAccessionLabel, svSpeciesSelectionKey } from './svFormat.js'
import { IconUpDown } from './svIcons'
import { getSvRegionKey } from './svWindows.js'

export function AvailableSvAlignmentsPanel({
  theme,
  catalog,
  activeSpecies,
  inactiveSpecies,
  anchorSpecies,
  secondSpecies,
  thirdSpecies,
  regionExplicitlySelected,
  onAction,
}) {
  const isLight = theme === 'light'
  const [expandedRows, setExpandedRows] = useState({})
  const rows = useMemo(
    () => buildAvailableSvAlignmentRows(catalog, activeSpecies, inactiveSpecies),
    [catalog, activeSpecies, inactiveSpecies],
  )
  const fullyActiveKeys = useMemo(() => {
    const keys = []
    if (anchorSpecies) keys.push(svSpeciesSelectionKey(anchorSpecies))
    if (regionExplicitlySelected && secondSpecies) keys.push(svSpeciesSelectionKey(secondSpecies))
    if (regionExplicitlySelected && thirdSpecies) keys.push(svSpeciesSelectionKey(thirdSpecies))
    return new Set(keys.filter(Boolean))
  }, [anchorSpecies, regionExplicitlySelected, secondSpecies, thirdSpecies])

  const panelClass = isLight
    ? 'border-gray-200 bg-white text-gray-900'
    : 'border-gray-700 bg-[#111827] text-gray-100'
  const tableGridClass = 'md:grid-cols-[28px_minmax(360px,3fr)_minmax(220px,1.6fr)_88px_110px_150px]'
  const rowClass = `grid gap-2 border-b px-3 py-2 text-xs transition-colors ${tableGridClass} md:items-center ${
    isLight
      ? 'border-gray-100 hover:bg-gray-50'
      : 'border-gray-700/70 hover:bg-slate-800/70'
  }`
  const detailClass = isLight ? 'border-gray-100 bg-gray-50 text-gray-700' : 'border-gray-700 bg-slate-900/70 text-gray-300'
  const mutedClass = isLight ? 'text-gray-500' : 'text-gray-400'
  const strongClass = isLight ? 'text-gray-900' : 'text-gray-100'
  const buttonClass = `inline-flex h-7 items-center justify-center rounded border px-2 text-xs leading-none transition-colors ${
    isLight ? 'border-gray-300 bg-white text-gray-700 hover:bg-gray-100 disabled:bg-gray-100 disabled:text-gray-400' : 'border-gray-600 bg-slate-800 text-gray-100 hover:bg-slate-700 disabled:bg-slate-800 disabled:text-gray-500'
  }`
  const statusClass = (status) => {
    if (status === 'usable') return isLight ? 'text-emerald-700' : 'text-emerald-300'
    if (status === 'downloadable') return isLight ? 'text-blue-700' : 'text-blue-300'
    if (status === 'missing_files') return isLight ? 'text-amber-700' : 'text-amber-300'
    return isLight ? 'text-gray-500' : 'text-gray-400'
  }
  const formatGenome = (state) => state.species
    ? getSpeciesDisplayName(state.species)
    : getSvCatalogGenomeDisplayName(state.genome)
  const formatGenomeTooltip = (state) => {
    const genome = state.genome || state.species || {}
    const label = formatGenome(state)
    const accession = getSvGenomeAccessionLabel(genome)
    const aliases = Array.isArray(genome.aliases) ? genome.aliases : []
    return [label, accession, ...aliases.slice(0, 6)].filter(Boolean).join(' | ')
  }
  const getMiniPillStyle = (state) => {
    const isFullyActive = Boolean(state.speciesKey && fullyActiveKeys.has(state.speciesKey))
    if (isFullyActive) {
      return {
        backgroundColor: isLight ? '#0099ff' : '#0077cc',
        color: '#ffffff',
        borderColor: 'transparent',
        borderStyle: 'solid',
      }
    }
    if (state.isActive) {
      return {
        backgroundColor: isLight ? '#ffffff' : 'transparent',
        color: isLight ? '#1d4ed8' : '#93c5fd',
        borderColor: isLight ? '#60a5fa' : '#3b82f6',
        borderStyle: 'solid',
      }
    }
    if (state.isSelected) {
      return {
        backgroundColor: isLight ? '#ffffff' : '#1E2938',
        color: isLight ? '#4b5563' : '#9ca3af',
        borderColor: isLight ? '#d1d5db' : '#4b5563',
        borderStyle: 'solid',
      }
    }
    return {
      backgroundColor: isLight ? '#ffffff' : 'transparent',
      color: isLight ? '#6b7280' : '#9ca3af',
      borderColor: isLight ? '#d1d5db' : '#4b5563',
      borderStyle: 'dashed',
    }
  }
  const renderMiniGenomePill = (row, side) => {
    const state = side === 'reference' ? row.reference : row.target
    const canAddInactive = Boolean(state.isLocal && !state.isSelected)
    const action = side === 'reference' ? 'add_reference_inactive' : 'add_target_inactive'
    return (
      <span className="group/align-pill relative min-w-0 max-w-[48%]">
        <span
          className="inline-flex max-w-full min-w-[92px] items-center rounded-full border px-2.5 py-1 text-[11px] font-medium"
          style={getMiniPillStyle(state)}
          title={formatGenomeTooltip(state)}
        >
          <span className="truncate">{formatGenome(state)}</span>
        </span>
        {canAddInactive && (
          <button
            type="button"
            className={`absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full border opacity-0 transition-opacity group-hover/align-pill:opacity-100 ${
              isLight
                ? 'border-gray-300 bg-white text-gray-500 hover:border-blue-400 hover:text-blue-600'
                : 'border-gray-500 bg-gray-800 text-gray-300 hover:border-blue-400 hover:text-blue-300'
            }`}
            title="Add genome to list"
            aria-label="Add genome to list"
            onClick={(event) => {
              event.stopPropagation()
              onAction?.(row, action)
            }}
          >
            <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
              <line x1="5" y1="2" x2="5" y2="8" />
              <line x1="2" y1="5" x2="8" y2="5" />
            </svg>
          </button>
        )}
      </span>
    )
  }
  const formatStatus = (row) => {
    if (row.status === 'usable') return 'Usable'
    if (row.status === 'downloadable') return 'Downloadable'
    if (row.status === 'missing_files') return 'Missing files'
    return 'Unavailable'
  }
  const renderActionButtons = (row) => {
    const buttons = []
    if (row.supported && row.canUse) {
      buttons.push(
        <button key="use" type="button" className={buttonClass} onClick={(event) => { event.stopPropagation(); onAction?.(row, 'use') }}>
          Use alignment
        </button>,
      )
    }
    if (row.supported && row.canDownloadReference) {
      buttons.push(
        <button key="download-ref" type="button" className={buttonClass} onClick={(event) => { event.stopPropagation(); onAction?.(row, 'download_reference') }}>
          Download reference
        </button>,
      )
    }
    if (row.supported && row.canDownloadTarget) {
      buttons.push(
        <button key="download-target" type="button" className={buttonClass} onClick={(event) => { event.stopPropagation(); onAction?.(row, 'download_target') }}>
          Download target
        </button>,
      )
    }
    // Offered whatever the state: an entry with missing files is exactly the one
    // most likely to need its paths corrected or to be removed outright.
    buttons.push(
      <button key="remove" type="button" className={buttonClass} onClick={(event) => { event.stopPropagation(); onAction?.(row, 'remove') }}>
        Remove
      </button>,
    )
    return <div className="flex flex-wrap items-center gap-1.5">{buttons}</div>
  }
  const renderFileDetail = (label, file) => {
    const path = String(file?.path || '').trim()
    const ok = Boolean(file?.exists)
    return (
      <div className="min-w-0">
        <div className={`font-semibold ${strongClass}`}>{label}</div>
        <div className={`truncate font-mono text-[11px] ${path ? mutedClass : statusClass('missing_files')}`} title={path}>
          {path || 'Not set'}{path ? (ok ? ' (found)' : ' (missing)') : ''}
        </div>
      </div>
    )
  }
  const renderGenomeDetail = (title, state, aliases) => {
    const genome = state.genome || {}
    const accession = getSvGenomeAccessionLabel(genome)
    const aliasList = Array.from(new Set([...(aliases || []), ...(genome.aliases || [])])).filter(Boolean)
    return (
      <div className="min-w-0">
        <div className={`font-semibold ${strongClass}`}>{title}</div>
        <div className="truncate" title={formatGenome(state)}>{formatGenome(state)}</div>
        <div className={`truncate font-mono text-[11px] ${mutedClass}`} title={accession}>{accession || 'No accession'}</div>
        <div className={`truncate text-[11px] ${mutedClass}`} title={aliasList.join(', ')}>
          {aliasList.length ? `Aliases: ${aliasList.slice(0, 8).join(', ')}${aliasList.length > 8 ? '...' : ''}` : 'No aliases'}
        </div>
      </div>
    )
  }

  return (
    <div className={`mt-1 w-full md:col-span-full border ${panelClass}`}>
      <div className={`flex items-center justify-between border-b px-3 py-2 text-xs ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
        <span className="font-semibold">Available alignments</span>
        <span className={mutedClass}>{rows.length} registered</span>
      </div>
      {rows.length === 0 ? (
        <div className={`px-3 py-3 text-sm ${mutedClass}`}>No SV alignments are registered.</div>
      ) : (
        <div>
          <div className={`hidden border-b px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide md:grid ${tableGridClass} md:gap-2 ${isLight ? 'border-gray-100 text-gray-500' : 'border-gray-700 text-gray-400'}`}>
            <span />
            <span>Direction</span>
            <span>Label</span>
            <span>Regions</span>
            <span>Status</span>
            <span>Action</span>
          </div>
          {rows.map((row) => {
            const expanded = Boolean(expandedRows[row.id])
            const alignment = row.alignment || {}
            const sourceLabel = alignment.label || row.id
            const regions = Array.isArray(alignment.reference_regions) ? alignment.reference_regions : []
            return (
              <div key={row.id}>
                <div className={`w-full text-left ${rowClass}`}>
                  <span className="flex items-center">
                    <button
                      type="button"
                      className={`inline-flex h-6 w-6 items-center justify-center rounded border ${isLight ? 'border-gray-300 bg-white text-gray-500 hover:bg-gray-100' : 'border-gray-600 bg-slate-800 text-gray-300 hover:bg-slate-700'}`}
                      onClick={(event) => {
                        event.stopPropagation()
                        setExpandedRows((prev) => ({ ...prev, [row.id]: !prev[row.id] }))
                      }}
                      title={expanded ? 'Collapse alignment details' : 'Expand alignment details'}
                    >
                      <IconUpDown open={expanded} size={13} />
                    </button>
                  </span>
                  <span
                    className="flex min-w-0 items-center gap-2"
                    title={`${formatGenomeTooltip(row.reference)} -> ${formatGenomeTooltip(row.target)}`}
                  >
                    {renderMiniGenomePill(row, 'reference')}
                    <span className={`shrink-0 text-xs font-semibold ${mutedClass}`}>-&gt;</span>
                    {renderMiniGenomePill(row, 'target')}
                  </span>
                  <span className="truncate" title={sourceLabel}>{sourceLabel}</span>
                  <span>{row.regionCount} {row.regionCount === 1 ? 'region' : 'regions'}</span>
                  <span className={statusClass(row.status)}>{formatStatus(row)}</span>
                  <span>{renderActionButtons(row)}</span>
                </div>
                {expanded && (
                  <div className={`border-b px-3 py-3 text-xs ${detailClass}`}>
                    {alignment.description && (
                      <div className={`mb-3 ${mutedClass}`}>{alignment.description}</div>
                    )}
                    <div className="grid gap-3 md:grid-cols-3">
                      {renderFileDetail('BigChain', alignment.files?.bigchain)}
                      <div>
                        <div className={`font-semibold ${strongClass}`}>Indexed side</div>
                        <div>{alignment.indexed_side || 'target'}</div>
                      </div>
                      <div className="min-w-0">
                        <div className={`font-semibold ${strongClass}`}>Defined in</div>
                        <div className={`truncate font-mono text-[11px] ${mutedClass}`} title={alignment.config_path || ''}>
                          {alignment.config_path || (alignment.source === 'scanned' ? 'Scanned bundle' : 'This installation')}
                        </div>
                      </div>
                      {/* Only shown for records migrated from before sequence names
                          were derived from the assemblies. */}
                      {alignment.files?.reference_mapping?.path && renderFileDetail('Reference mapping TSV (legacy)', alignment.files.reference_mapping)}
                      {alignment.files?.target_mapping?.path && renderFileDetail('Target mapping TSV (legacy)', alignment.files.target_mapping)}
                      {renderGenomeDetail('Reference genome', row.reference, alignment.ref_aliases)}
                      {renderGenomeDetail('Target genome', row.target, alignment.tgt_aliases)}
                    </div>
                    {row.missingFiles.length > 0 && (
                      <div className={`mt-3 ${statusClass('missing_files')}`}>
                        Missing: {row.missingFiles.join(', ')}
                      </div>
                    )}
                    <div className="mt-3">
                      <div className={`font-semibold ${strongClass}`}>Reference regions</div>
                      <div className={`mt-1 flex flex-wrap gap-1 ${mutedClass}`}>
                        {regions.length === 0 ? (
                          <span>No regions listed</span>
                        ) : (
                          <>
                            {regions.slice(0, 20).map((region) => {
                              const key = getSvRegionKey(region)
                              return (
                                <span key={key} className={`rounded border px-1.5 py-0.5 ${isLight ? 'border-gray-200 bg-white' : 'border-gray-700 bg-slate-950'}`}>
                                  {region.label || region.chrom || key}
                                </span>
                              )
                            })}
                            {regions.length > 20 && <span>+{regions.length - 20} more</span>}
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

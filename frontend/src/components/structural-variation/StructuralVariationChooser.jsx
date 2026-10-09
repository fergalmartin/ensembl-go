import { useCallback, useEffect, useMemo, useState } from 'react'
import { buildSvGenomeOptions, catalogGenomeMatchesSpecies, getOutgoingSvAlignments } from '../../utils/svCatalog.js'
import { StructuralVariationRegistrationForm } from './StructuralVariationRegistrationForm'
import { dedupeSvSpeciesList, getSvOptionTooltip, svGenomeOptionNaming, svSpeciesSelectionKey } from './svFormat.js'
import { renderSvGenomeOptionGroups } from './svGenomeOptions'
import { alignmentSupportsAnchorRegion, formatSvRegionAvailabilityLabel, getSvRegionKey, getSvRegionLength } from './svWindows.js'

export function StructuralVariationChooser({
  theme,
  catalog,
  catalogLoading,
  catalogError,
  activeSpecies,
  inactiveSpecies,
  anchorSpecies,
  secondSpecies,
  thirdSpecies,
  selectedSecondAlignment,
  selectedThirdAlignment,
  anchorRegionOptions = [],
  selectedAnchorRegionId = '',
  regionExplicitlySelected = false,
  onAnchorRegionChange = null,
  onAnchorRegionSearch = null,
  onGenomeOrderChange,
  onOpenGenomeSelector,
  onRegisteredAlignment,
  onRemoveAlignment,
  outputDir,
}) {
  const isLight = theme === 'light'
  const [locationInput, setLocationInput] = useState('')
  const knownSpecies = useMemo(() => {
    const catalogLocalSpecies = []
    for (const genome of catalog?.genomes || []) {
      if (genome?.local_species) catalogLocalSpecies.push(genome.local_species)
    }
    return dedupeSvSpeciesList([...activeSpecies, ...inactiveSpecies, ...catalogLocalSpecies])
  }, [activeSpecies, inactiveSpecies, catalog])

  const activeKeys = useMemo(() => new Set(activeSpecies.map((species) => svSpeciesSelectionKey(species))), [activeSpecies])
  const selectedKeys = useMemo(() => new Set(
    dedupeSvSpeciesList([...activeSpecies, ...inactiveSpecies]).map((species) => svSpeciesSelectionKey(species)),
  ), [activeSpecies, inactiveSpecies])
  const anchorOptions = useMemo(() => {
    // Every genome that anchors at least one usable alignment, whether or not it is
    // in the top bar. Restricting this to the top bar meant loading a config
    // appeared to do nothing: its genomes were known but could not be chosen.
    const seen = new Set()
    const anchorGenomes = []
    for (const alignment of catalog?.alignments || []) {
      if (!alignment?.supported) continue
      const genome = alignment.reference_genome
      const id = String(genome?.id || '')
      if (!genome || (id && seen.has(id))) continue
      if (id) seen.add(id)
      anchorGenomes.push(genome)
    }
    return buildSvGenomeOptions(anchorGenomes, knownSpecies, selectedKeys, activeKeys, svGenomeOptionNaming)
  }, [catalog, knownSpecies, selectedKeys, activeKeys])

  const outgoingAlignments = useMemo(() => getOutgoingSvAlignments(catalog, anchorSpecies), [catalog, anchorSpecies])
  const hasSelectedAnchorRegion = Boolean(selectedAnchorRegionId && regionExplicitlySelected)
  const selectedAnchorRegionOption = useMemo(() => {
    return (anchorRegionOptions || []).find((region) => getSvRegionKey(region) === selectedAnchorRegionId) || null
  }, [anchorRegionOptions, selectedAnchorRegionId])
  const targetOptions = useMemo(() => {
    if (!hasSelectedAnchorRegion) return []
    const seen = new Set()
    const genomes = []
    const alignmentByGenomeId = new Map()
    for (const alignment of outgoingAlignments) {
      const genome = alignment?.target_genome
      if (!genome?.id || seen.has(genome.id)) continue
      // A genome that is not downloaded has no sequence names to intersect, so its
      // alignments list no regions and the region filter would drop it silently.
      // Keep it: the option is disabled anyway, and a config's genome explaining
      // why it cannot be used beats it simply not being there.
      const regionUnknowable = !genome.local
      if (selectedAnchorRegionId && !regionUnknowable && !alignmentSupportsAnchorRegion(alignment, selectedAnchorRegionId)) continue
      seen.add(genome.id)
      genomes.push(genome)
      alignmentByGenomeId.set(genome.id, alignment)
    }
    return buildSvGenomeOptions(genomes, knownSpecies, selectedKeys, activeKeys, svGenomeOptionNaming).map((option) => {
      const alignment = alignmentByGenomeId.get(String(option.genome?.id || '')) || null
      const supported = Boolean(alignment?.supported)
      return {
        ...option,
        alignment,
        supported,
        disabled: option.disabled || !supported,
      }
    })
  }, [outgoingAlignments, knownSpecies, activeKeys, selectedKeys, selectedAnchorRegionId, hasSelectedAnchorRegion])

  const optionByValue = useMemo(() => {
    const map = new Map()
    for (const option of [...anchorOptions, ...targetOptions]) {
      map.set(option.value, option)
    }
    return map
  }, [anchorOptions, targetOptions])

  const selectedAnchorValue = anchorSpecies ? `species:${svSpeciesSelectionKey(anchorSpecies)}` : ''
  const selectedSecondValue = secondSpecies ? `species:${svSpeciesSelectionKey(secondSpecies)}` : ''
  const selectedThirdValue = thirdSpecies ? `species:${svSpeciesSelectionKey(thirdSpecies)}` : ''
  const selectedAnchorOption = optionByValue.get(selectedAnchorValue)
  const selectedSecondOption = optionByValue.get(selectedSecondValue)
  const selectedThirdOption = optionByValue.get(selectedThirdValue)

  const promoteOrder = useCallback((nextAnchor, nextSecond, nextThird, options = {}) => {
    const ordered = dedupeSvSpeciesList([nextAnchor, nextSecond, nextThird])
    const slotOptions = {
      anchorKey: nextAnchor ? svSpeciesSelectionKey(nextAnchor) : '',
      secondKey: nextSecond ? svSpeciesSelectionKey(nextSecond) : '',
      thirdKey: nextThird ? svSpeciesSelectionKey(nextThird) : '',
      regionId: selectedAnchorRegionId,
      regionExplicitlySelected: hasSelectedAnchorRegion,
      ...options,
    }
    onGenomeOrderChange?.(ordered, slotOptions)
  }, [hasSelectedAnchorRegion, onGenomeOrderChange, selectedAnchorRegionId])

  const handleAnchorChange = useCallback((value) => {
    const option = optionByValue.get(value)
    if (!option?.species) {
      if (option?.genome?.downloadable) onOpenGenomeSelector?.()
      return
    }
    const nextAnchor = option.species
    promoteOrder(nextAnchor, null, null, {
      deactivateSpecies: anchorSpecies ? [anchorSpecies] : [],
      anchorKey: svSpeciesSelectionKey(nextAnchor),
      secondKey: '',
      thirdKey: '',
      clearRegion: true,
    })
  }, [anchorSpecies, optionByValue, promoteOrder, onOpenGenomeSelector])

  const handleTargetChange = useCallback((slot, value) => {
    if (!value) {
      if (slot === 'second') {
        const promotedThird = thirdSpecies || null
        promoteOrder(
          anchorSpecies,
          promotedThird,
          null,
          {
            deactivateSpecies: secondSpecies ? [secondSpecies] : [],
            secondKey: promotedThird ? svSpeciesSelectionKey(promotedThird) : '',
            thirdKey: '',
          },
        )
      } else {
        promoteOrder(
          anchorSpecies,
          secondSpecies,
          null,
          {
            deactivateSpecies: thirdSpecies ? [thirdSpecies] : [],
            thirdKey: '',
          },
        )
      }
      return
    }
    const option = optionByValue.get(value)
    if (!option?.species) {
      if (option?.genome?.downloadable) onOpenGenomeSelector?.()
      return
    }
    if (slot === 'second') {
      const nextThird = thirdSpecies && svSpeciesSelectionKey(thirdSpecies) !== svSpeciesSelectionKey(option.species) ? thirdSpecies : null
      promoteOrder(anchorSpecies, option.species, nextThird)
    } else {
      promoteOrder(anchorSpecies, secondSpecies, option.species)
    }
  }, [anchorSpecies, secondSpecies, thirdSpecies, optionByValue, promoteOrder, onOpenGenomeSelector])

  const handleAvailableAlignmentAction = useCallback((row, action) => {
    if (!row) return
    if (action === 'download_reference' || action === 'download_target') {
      onOpenGenomeSelector?.()
      return
    }
    if (action === 'remove') {
      onRemoveAlignment?.(row)
      return
    }
    if (action === 'add_reference_inactive' || action === 'add_target_inactive') {
      const species = action === 'add_reference_inactive'
        ? row.reference?.species
        : row.target?.species
      if (!species) return
      promoteOrder(null, null, null, {
        allowEmpty: true,
        deactivateSpecies: [species],
        anchorKey: anchorSpecies ? svSpeciesSelectionKey(anchorSpecies) : '',
        secondKey: secondSpecies ? svSpeciesSelectionKey(secondSpecies) : '',
        thirdKey: thirdSpecies ? svSpeciesSelectionKey(thirdSpecies) : '',
        regionId: selectedAnchorRegionId,
        regionExplicitlySelected: hasSelectedAnchorRegion,
      })
      return
    }

    const referenceSpecies = row.reference?.species || null
    const targetSpecies = row.target?.species || null
    if (!referenceSpecies || !targetSpecies || action !== 'use') return
    const regions = Array.isArray(row.alignment?.reference_regions) ? row.alignment.reference_regions : []
    const largestRegion = regions.reduce((best, region) => {
      if (!best) return region
      return getSvRegionLength(region) > getSvRegionLength(best) ? region : best
    }, null)
    const largestRegionId = getSvRegionKey(largestRegion)

    promoteOrder(referenceSpecies, targetSpecies || null, null, {
      anchorKey: svSpeciesSelectionKey(referenceSpecies),
      secondKey: targetSpecies ? svSpeciesSelectionKey(targetSpecies) : '',
      thirdKey: '',
      regionId: largestRegionId || selectedAnchorRegionId,
      regionExplicitlySelected: Boolean(largestRegionId) || hasSelectedAnchorRegion,
    })
  }, [anchorSpecies, hasSelectedAnchorRegion, onOpenGenomeSelector, onRemoveAlignment, promoteOrder, secondSpecies, selectedAnchorRegionId, thirdSpecies])

  useEffect(() => {
    if (catalogLoading || !anchorSpecies) return
    if (!hasSelectedAnchorRegion) {
      if (secondSpecies || thirdSpecies) {
        promoteOrder(anchorSpecies, null, null, { secondKey: '', thirdKey: '' })
      }
      return
    }
    const activeOrder = new Map((activeSpecies || []).map((species, index) => [svSpeciesSelectionKey(species), index]))
    const validTargetOptions = targetOptions
      .filter((option) => option.species && option.isSelected && !option.disabled)
      .sort((a, b) => {
        const aOrder = activeOrder.has(svSpeciesSelectionKey(a.species)) ? activeOrder.get(svSpeciesSelectionKey(a.species)) : 999
        const bOrder = activeOrder.has(svSpeciesSelectionKey(b.species)) ? activeOrder.get(svSpeciesSelectionKey(b.species)) : 999
        if (aOrder !== bOrder) return aOrder - bOrder
        return a.label.localeCompare(b.label)
      })
    const secondIsValid = secondSpecies && validTargetOptions.some((option) => catalogGenomeMatchesSpecies(option.genome, secondSpecies))
    const thirdIsValid = thirdSpecies && validTargetOptions.some((option) => catalogGenomeMatchesSpecies(option.genome, thirdSpecies))
    let nextSecond = secondIsValid ? secondSpecies : null
    let nextThird = thirdIsValid ? thirdSpecies : null
    if (!nextSecond && nextThird) {
      nextSecond = nextThird
      nextThird = null
    }
    if (nextSecond && nextThird && svSpeciesSelectionKey(nextSecond) === svSpeciesSelectionKey(nextThird)) {
      nextThird = null
    }
    const nextSecondKey = svSpeciesSelectionKey(nextSecond)
    const nextThirdKey = svSpeciesSelectionKey(nextThird)
    if (svSpeciesSelectionKey(secondSpecies) === nextSecondKey && svSpeciesSelectionKey(thirdSpecies) === nextThirdKey) return
    promoteOrder(anchorSpecies, nextSecond, nextThird)
  }, [
    anchorSpecies,
    secondSpecies,
    thirdSpecies,
    selectedAnchorRegionId,
    hasSelectedAnchorRegion,
    targetOptions,
    activeSpecies,
    promoteOrder,
    catalogLoading,
  ])

  const handleLocationSubmit = useCallback((event) => {
    event?.preventDefault?.()
    const query = String(locationInput || '').trim()
    if (!query) return
    const ok = onAnchorRegionSearch?.(query)
    if (ok === false) {
      setLocationInput('')
    }
  }, [locationInput, onAnchorRegionSearch])

  const unavailableSelected = [
    selectedSecondAlignment && !selectedSecondAlignment.supported ? selectedSecondAlignment : null,
    selectedThirdAlignment && !selectedThirdAlignment.supported ? selectedThirdAlignment : null,
  ].filter(Boolean)
  const missingCatalogRows = (catalog?.alignments || []).filter((alignment) => !alignment?.supported)
  const bandClass = isLight ? 'border-gray-200 bg-gray-50 text-gray-900' : 'border-gray-700 bg-[#152033] text-gray-100'
  const mutedClass = isLight ? 'text-gray-600' : 'text-gray-400'
  const fieldClass = 'flex min-w-0 flex-col gap-1'
  const fieldLabelClass = `h-4 text-xs font-semibold leading-4 ${mutedClass}`
  const controlBaseClass = 'h-8 min-w-[220px] max-w-full overflow-hidden text-ellipsis whitespace-nowrap rounded border py-0 pl-2 pr-8 text-sm leading-tight'
  const selectClass = `${controlBaseClass} ${
    isLight ? 'border-gray-300 bg-white text-gray-900' : 'border-gray-600 bg-slate-900 text-gray-100'
  }`
  const disabledSelectClass = `${controlBaseClass} opacity-65 cursor-not-allowed ${
    isLight ? 'border-gray-200 bg-gray-100 text-gray-500' : 'border-gray-700 bg-slate-800 text-gray-500'
  }`
  const buttonClass = `inline-flex h-8 items-center justify-center rounded border px-2.5 text-xs leading-none transition-colors ${
    isLight ? 'border-gray-300 bg-gray-50 text-gray-700 hover:bg-gray-100' : 'border-gray-600 bg-slate-800 text-gray-100 hover:bg-slate-700'
  }`
  const thirdTargetOptions = targetOptions.filter((option) => option.value !== selectedSecondValue)
  const secondSelectDisabled = !anchorSpecies || !hasSelectedAnchorRegion
  const thirdSelectDisabled = secondSelectDisabled || !selectedSecondValue || (!selectedThirdValue && !thirdTargetOptions.some((option) => !option.disabled))

  return (
    <div className={`border ${bandClass} px-3 py-2`}>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-[minmax(220px,260px)_minmax(220px,260px)_minmax(260px,360px)_minmax(300px,1fr)] md:items-end">
        <label className={`${fieldClass} md:col-start-1 md:row-start-1`}>
          <span className={fieldLabelClass}>Anchor</span>
          <select className={selectClass} value={selectedAnchorValue} title={getSvOptionTooltip(selectedAnchorOption)} onChange={(event) => handleAnchorChange(event.target.value)}>
            {!selectedAnchorValue && <option value="">Select anchor</option>}
            {renderSvGenomeOptionGroups(anchorOptions, 'anchor')}
          </select>
        </label>

        <label className={`${fieldClass} md:col-start-2 md:row-start-1`}>
          <span className={fieldLabelClass}>Region</span>
          <select
            className={selectClass}
            value={hasSelectedAnchorRegion ? selectedAnchorRegionId : ''}
            title={selectedAnchorRegionOption ? `Anchor region ${selectedAnchorRegionOption.label || selectedAnchorRegionOption.chrom}` : ''}
            onChange={(event) => onAnchorRegionChange?.(event.target.value)}
            disabled={!anchorRegionOptions.length}
          >
            {anchorRegionOptions.length > 0 && <option value="">Select</option>}
            {!anchorRegionOptions.length && <option value="">No aligned regions</option>}
            {hasSelectedAnchorRegion && selectedAnchorRegionId && !selectedAnchorRegionOption && (
              <option value={selectedAnchorRegionId}>{selectedAnchorRegionId}</option>
            )}
            {anchorRegionOptions.map((region) => {
              const key = getSvRegionKey(region)
              const availabilityLabel = formatSvRegionAvailabilityLabel(region, outgoingAlignments)
              return (
                <option key={key} value={key}>
                  {region.label || region.chrom || key}{availabilityLabel ? ` (${availabilityLabel})` : ''}
                </option>
              )
            })}
          </select>
        </label>

        <form className={`${fieldClass} md:col-start-3 md:row-start-1`} onSubmit={handleLocationSubmit}>
          <span className={fieldLabelClass}>Location</span>
          <div className="flex h-8 gap-2">
            <input
              className={`h-8 min-w-0 flex-1 rounded border px-2 text-sm leading-tight ${
                isLight ? 'border-gray-300 bg-white text-gray-900' : 'border-gray-600 bg-slate-900 text-gray-100'
              }`}
              value={locationInput}
              placeholder=""
              onChange={(event) => setLocationInput(event.target.value)}
            />
            <button type="submit" className={buttonClass}>
              Go
            </button>
          </div>
        </form>

        <label className={`${fieldClass} md:col-start-1 md:row-start-2`}>
          <span className={fieldLabelClass}>Second</span>
          <select className={secondSelectDisabled ? disabledSelectClass : selectClass} value={selectedSecondValue} title={getSvOptionTooltip(selectedSecondOption)} onChange={(event) => handleTargetChange('second', event.target.value)} disabled={secondSelectDisabled}>
            <option value="">{selectedSecondValue ? 'None' : 'Select'}</option>
            {renderSvGenomeOptionGroups(targetOptions, 'second')}
          </select>
        </label>

        <label className={`${fieldClass} md:col-start-2 md:row-start-2`}>
          <span className={fieldLabelClass}>Third</span>
          <select className={thirdSelectDisabled ? disabledSelectClass : selectClass} value={selectedThirdValue} title={getSvOptionTooltip(selectedThirdOption)} onChange={(event) => handleTargetChange('third', event.target.value)} disabled={thirdSelectDisabled}>
            <option value="">{selectedThirdValue ? 'None' : 'Select'}</option>
            {renderSvGenomeOptionGroups(thirdTargetOptions, 'third')}
          </select>
        </label>

        <StructuralVariationRegistrationForm
          className="md:col-start-3 md:col-span-2 md:row-start-2"
          theme={theme}
          catalog={catalog}
          activeSpecies={activeSpecies}
          inactiveSpecies={inactiveSpecies}
          anchorSpecies={anchorSpecies}
          secondSpecies={secondSpecies}
          thirdSpecies={thirdSpecies}
          regionExplicitlySelected={hasSelectedAnchorRegion}
          outputDir={outputDir}
          onRegistered={onRegisteredAlignment}
          onAvailableAlignmentAction={handleAvailableAlignmentAction}
          onOpenGenomeSelector={onOpenGenomeSelector}
        />
      </div>

      {catalogError && (
        <div className={`mt-2 flex flex-wrap items-center gap-2 text-xs ${mutedClass}`}>
          <span className={isLight ? 'text-red-600' : 'text-red-300'}>{catalogError}</span>
        </div>
      )}

      {targetOptions.some((option) => !option.species && option.genome?.downloadable) && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {targetOptions.filter((option) => !option.species && option.genome?.downloadable).map((option) => (
            <button key={`download-${option.value}`} type="button" className={buttonClass} onClick={() => onOpenGenomeSelector?.()}>
              Download {option.label}
            </button>
          ))}
        </div>
      )}

      {(unavailableSelected.length > 0 || missingCatalogRows.length > 0) && (
        <div className={`mt-2 text-xs ${isLight ? 'text-amber-700' : 'text-amber-300'}`}>
          {unavailableSelected.length > 0
            ? unavailableSelected.map((alignment) => `${alignment.label || alignment.id}: ${(alignment.missing_files || []).join(', ')}`).join(' | ')
            : `${missingCatalogRows.length} alignment${missingCatalogRows.length === 1 ? '' : 's'} have missing BigChain or mapping files.`}
        </div>
      )}
    </div>
  )
}

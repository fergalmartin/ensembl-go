// Choosing and ordering the active genomes from the app shell: toggling and
// reordering pills, the structural-variation genome trio, and changes made in the
// Genome Selector.
import {
    appendUniqueSpecies,
    dedupeSpeciesList,
    getViewActiveCapacity,
    prependUniqueSpecies,
    speciesItemKey,
    speciesListsEqualByKey,
} from './genomeLists.js'
import { withNextPreviousSessionGenomes } from './previousSessionPlaylist.js'
import { sameStringArrayItems } from './genomeLists.js'
import { SV_NO_ANCHOR_KEY } from './viewSpecies.js'
import { genomeKeysMatch } from '../utils/genomeIdentity.js'
import { reorderWithInsertPosition } from './genomeLists.js'

export async function toggleSpeciesPill(ctx, species, source = 'pill', options = {}) {
    const {
        buildFocusFromActive,
        config,
        configRef,
        currentView,
        dualViewFocusRef,
        getAlignedGenomeConfigForView,
        getContextFullyActiveSpecies,
        handleBrowserConfigChange,
        hasGenomeAssignmentChanges,
        inactiveSelectedSpeciesRef,
        persistNextPreviousSessionGenomes,
        setDualViewFocus,
        setInactiveSelectedSpecies,
        suppressViewSyncRef,
        toggleTutorialGenome,
        tutorialConfig,
    } = ctx
	    if (!species) return { ok: false, reason: 'missing_species' }
	    const desired = options?.desired || ''

	    // A tutorial keeps its own set of active genomes, so choosing one here must not
	    // reach the user's real selection.
	    if (tutorialConfig) {
	      toggleTutorialGenome(species, desired)
	      return { ok: true }
	    }

	    const key = speciesItemKey(species)
	    const currentConfig = configRef.current || config
	    const active = dedupeSpeciesList(currentConfig?.active_species)
	    const inactive = dedupeSpeciesList(inactiveSelectedSpeciesRef.current)
	    if (desired) {
	      const chosen = active.some((item) => speciesItemKey(item) === key)
	        || inactive.some((item) => speciesItemKey(item) === key)
	      if ((desired === 'selected' && chosen) || (desired === 'deselected' && !chosen)) {
	        return { ok: true, reason: 'already_in_desired_state' }
	      }
	    }
	    const viewCapacity = getViewActiveCapacity(currentView)
	    const activeIndex = active.findIndex((item) => speciesItemKey(item) === key)
	    const inactiveIndex = inactive.findIndex((item) => speciesItemKey(item) === key)
	    // The selector's tick means "chosen at all", active or not, so unticking there takes
	    // the genome out outright. Going through the pill logic below only demoted an active
	    // genome to inactive — still ticked — and once nothing was left active, the next
	    // click fell through to activation and put it straight back.
	    const fromSelector = source === 'selector' || source === 'selector_remove'
	    if (fromSelector && (activeIndex >= 0 || inactiveIndex >= 0)) {
	      const nextActive = active.filter((item) => speciesItemKey(item) !== key)
	      const nextInactive = inactive.filter((item) => speciesItemKey(item) !== key)
	      let nextFocus = buildFocusFromActive(nextActive, {
	        primaryKey: dualViewFocusRef.current.primaryKey === key ? '' : dualViewFocusRef.current.primaryKey,
	        secondaryKey: dualViewFocusRef.current.secondaryKey === key ? '' : dualViewFocusRef.current.secondaryKey,
	      })

	      suppressViewSyncRef.current = true
	      try {
	        setInactiveSelectedSpecies(nextInactive)
	        persistNextPreviousSessionGenomes([...nextActive, ...nextInactive], { ...currentConfig, active_species: nextActive })
	        if (
	          nextFocus.primaryKey !== dualViewFocusRef.current.primaryKey ||
	          nextFocus.secondaryKey !== dualViewFocusRef.current.secondaryKey
	        ) {
	          dualViewFocusRef.current = nextFocus
	          setDualViewFocus(nextFocus)
	        }
		        const nextConfig = getAlignedGenomeConfigForView(
		          withNextPreviousSessionGenomes(
		            { ...currentConfig, active_species: nextActive },
		            [...nextActive, ...nextInactive]
		          ),
	          currentView,
	          nextFocus
	        )
	        const activeChanged = !speciesListsEqualByKey(currentConfig?.active_species || [], nextConfig?.active_species || [])
	        if (activeChanged || hasGenomeAssignmentChanges(currentConfig, nextConfig)) {
	          await handleBrowserConfigChange(nextConfig)
	        }
	        return { ok: true, deselected: true }
	      } finally {
	        suppressViewSyncRef.current = false
	      }
	    }

	    let nextActive = active
    let nextInactive = inactive
    let nextFocus = buildFocusFromActive(active, dualViewFocusRef.current)
    const contextFullyActive = getContextFullyActiveSpecies(active, currentView, nextFocus)
    const contextFullyActiveKeys = new Set(contextFullyActive.map((item) => speciesItemKey(item)))
    const isGloballyActive = activeIndex >= 0
    const isFullyActive = isGloballyActive && contextFullyActiveKeys.has(key)
    const isSemiActive = isGloballyActive && !isFullyActive

    if (isSemiActive) {
      if ((Number.isFinite(viewCapacity) && viewCapacity <= 0) || (Number.isFinite(viewCapacity) && viewCapacity > 0 && contextFullyActive.length >= viewCapacity)) {
        const removed = active[activeIndex]
        nextActive = active.filter((item) => speciesItemKey(item) !== key)
        nextInactive = prependUniqueSpecies(inactive, removed)
        if (nextFocus.primaryKey === key) {
          nextFocus.primaryKey = nextFocus.secondaryKey || ''
          nextFocus.secondaryKey = ''
        } else if (nextFocus.secondaryKey === key) {
          nextFocus.secondaryKey = ''
        }
        nextFocus = buildFocusFromActive(nextActive, nextFocus)
      } else {
        nextInactive = inactive.filter((item) => speciesItemKey(item) !== key)
        if (viewCapacity === 1) {
          nextFocus.primaryKey = key
          nextFocus.secondaryKey = ''
        } else if (viewCapacity >= 2) {
          if (!nextFocus.primaryKey) {
            nextFocus.primaryKey = key
          } else if (!nextFocus.secondaryKey || nextFocus.secondaryKey === nextFocus.primaryKey) {
            nextFocus.secondaryKey = key
          }
        }
        nextFocus = buildFocusFromActive(nextActive, nextFocus)
      }
    } else if (isFullyActive) {
      const removed = active[activeIndex]
      nextActive = active.filter((item) => speciesItemKey(item) !== key)
      nextInactive = prependUniqueSpecies(inactive, removed)
      if (nextFocus.primaryKey === key) {
        nextFocus.primaryKey = nextFocus.secondaryKey || ''
        nextFocus.secondaryKey = ''
      } else if (nextFocus.secondaryKey === key) {
        nextFocus.secondaryKey = ''
      }
      nextFocus = buildFocusFromActive(nextActive, nextFocus)
    } else {
      if (source === 'selector' && currentView !== 'genome_browser' && currentView !== 'structural_variation' && active.length > 0) {
	        const appendedInactive = appendUniqueSpecies(inactive, species)
	        setInactiveSelectedSpecies(appendedInactive)
	        persistNextPreviousSessionGenomes([...active, ...appendedInactive], currentConfig)
	        return { ok: true, activated: false, reason: 'added_inactive' }
      }

      if (Number.isFinite(viewCapacity) && viewCapacity > 0 && contextFullyActive.length >= viewCapacity) {
        return {
          ok: false,
          reason: 'view_limit_reached',
          message: 'Deactivate one active genome in this view before activating another.',
        }
      }

      nextActive = appendUniqueSpecies(active, species)
      nextInactive = inactive.filter((item) => speciesItemKey(item) !== key)
      if (viewCapacity === 1) {
        nextFocus.primaryKey = key
        nextFocus.secondaryKey = ''
      } else if (!nextFocus.primaryKey && nextActive.length > 0) {
        nextFocus.primaryKey = speciesItemKey(nextActive[0])
      }
      nextFocus = buildFocusFromActive(nextActive, nextFocus)
    }

    suppressViewSyncRef.current = true
    try {
      setInactiveSelectedSpecies(nextInactive)
      if (
        nextFocus.primaryKey !== dualViewFocusRef.current.primaryKey ||
        nextFocus.secondaryKey !== dualViewFocusRef.current.secondaryKey
      ) {
        dualViewFocusRef.current = nextFocus
        setDualViewFocus(nextFocus)
      }

	      const nextConfig = getAlignedGenomeConfigForView(
	        withNextPreviousSessionGenomes(
	          { ...currentConfig, active_species: nextActive },
	          [...nextActive, ...nextInactive]
	        ),
	        currentView,
	        nextFocus
      )
      const activeChanged = !speciesListsEqualByKey(currentConfig?.active_species || [], nextConfig?.active_species || [])
      if (activeChanged || hasGenomeAssignmentChanges(currentConfig, nextConfig)) {
        await handleBrowserConfigChange(nextConfig)
      }
      return { ok: true, activated: activeIndex < 0 }
    } finally {
      suppressViewSyncRef.current = false
    }
  }

export async function changeStructuralVariationGenomeOrder(ctx, orderedSpecies, options = {}) {
    const {
        buildFocusFromActive,
        config,
        configRef,
        dualViewFocusRef,
        getAlignedGenomeConfigForView,
        handleBrowserConfigChange,
        hasGenomeAssignmentChanges,
        inactiveSelectedSpeciesRef,
        setDualViewFocus,
        setInactiveSelectedSpecies,
        setSvAnchorRegionId,
        setSvAnchorSpeciesKey,
        setSvFullyActiveSpeciesKeys,
        setSvRegionExplicitlySelected,
        setSvSecondSpeciesKey,
        setSvThirdSpeciesKey,
        suppressViewSyncRef,
        svAnchorRegionId,
        svAnchorSpeciesKey,
        svRegionExplicitlySelected,
        svSecondSpeciesKey,
        svThirdSpeciesKey,
    } = ctx
    const currentConfig = configRef.current || config
    const active = dedupeSpeciesList(currentConfig?.active_species)
    const inactive = dedupeSpeciesList(inactiveSelectedSpeciesRef.current)
    const byKey = new Map([...active, ...inactive].map((species) => [speciesItemKey(species), species]))
    const hasOption = (name) => Object.prototype.hasOwnProperty.call(options || {}, name)
    const deactivated = dedupeSpeciesList(options?.deactivateSpecies || [])
      .map((species) => byKey.get(speciesItemKey(species)) || species)
      .filter(Boolean)
    const deactivatedKeys = new Set(deactivated.map((species) => speciesItemKey(species)))
    const ordered = dedupeSpeciesList(orderedSpecies || [])
      .map((species) => byKey.get(speciesItemKey(species)) || species)
      .filter((species) => !deactivatedKeys.has(speciesItemKey(species)))
      .filter(Boolean)
    if (!ordered.length && !options?.allowEmpty) return

    const orderedKeys = new Set(ordered.map((species) => speciesItemKey(species)))
    const preservedActive = active.filter((species) => {
      const key = speciesItemKey(species)
      return !orderedKeys.has(key) && !deactivatedKeys.has(key)
    })
    const nextActive = dedupeSpeciesList([
      ...ordered,
      ...preservedActive,
    ])
    const nextInactive = dedupeSpeciesList([
      ...deactivated,
      ...inactive.filter((species) => {
        const key = speciesItemKey(species)
        return !orderedKeys.has(key) && !deactivatedKeys.has(key)
      }),
    ])
    const nextFocus = buildFocusFromActive(nextActive, {
      primaryKey: nextActive[0] ? speciesItemKey(nextActive[0]) : '',
      secondaryKey: nextActive[1] ? speciesItemKey(nextActive[1]) : '',
    })
    const nextSvAnchorKey = hasOption('anchorKey')
      ? String(options.anchorKey || '')
      : (ordered[0] ? speciesItemKey(ordered[0]) : svAnchorSpeciesKey)
    const nextSvSecondKey = hasOption('secondKey')
      ? String(options.secondKey || '')
      : (ordered[1] ? speciesItemKey(ordered[1]) : svSecondSpeciesKey)
    const nextSvThirdKey = hasOption('thirdKey')
      ? String(options.thirdKey || '')
      : (ordered[2] ? speciesItemKey(ordered[2]) : svThirdSpeciesKey)
    const nextSvRegionId = options?.clearRegion ? '' : (hasOption('regionId') ? String(options.regionId || '') : svAnchorRegionId)
    const nextSvRegionExplicitlySelected = options?.clearRegion
      ? false
      : (hasOption('regionExplicitlySelected') ? Boolean(options.regionExplicitlySelected) : svRegionExplicitlySelected)
    const svStateChanged =
      nextSvAnchorKey !== svAnchorSpeciesKey ||
      nextSvSecondKey !== svSecondSpeciesKey ||
      nextSvThirdKey !== svThirdSpeciesKey ||
      nextSvRegionId !== svAnchorRegionId ||
      nextSvRegionExplicitlySelected !== svRegionExplicitlySelected

    if (
      !svStateChanged &&
      speciesListsEqualByKey(active, nextActive) &&
      speciesListsEqualByKey(inactive, nextInactive) &&
      nextFocus.primaryKey === dualViewFocusRef.current.primaryKey &&
      nextFocus.secondaryKey === dualViewFocusRef.current.secondaryKey
    ) {
      return
    }

    suppressViewSyncRef.current = true
    try {
      if (nextSvAnchorKey !== svAnchorSpeciesKey) setSvAnchorSpeciesKey(nextSvAnchorKey)
      if (nextSvSecondKey !== svSecondSpeciesKey) setSvSecondSpeciesKey(nextSvSecondKey)
      if (nextSvThirdKey !== svThirdSpeciesKey) setSvThirdSpeciesKey(nextSvThirdKey)
      if (nextSvRegionId !== svAnchorRegionId) setSvAnchorRegionId(nextSvRegionId)
      if (nextSvRegionExplicitlySelected !== svRegionExplicitlySelected) {
        setSvRegionExplicitlySelected(nextSvRegionExplicitlySelected)
      }
      const immediateFullyActiveKeys = nextSvAnchorKey && nextSvAnchorKey !== SV_NO_ANCHOR_KEY
        ? [
            nextSvAnchorKey,
            ...(nextSvRegionExplicitlySelected ? [nextSvSecondKey, nextSvThirdKey] : []),
          ].filter(Boolean)
        : []
      setSvFullyActiveSpeciesKeys((prev) => (
        sameStringArrayItems(prev, immediateFullyActiveKeys) ? prev : immediateFullyActiveKeys
      ))
      setInactiveSelectedSpecies(nextInactive)
      if (
        nextFocus.primaryKey !== dualViewFocusRef.current.primaryKey ||
        nextFocus.secondaryKey !== dualViewFocusRef.current.secondaryKey
      ) {
        dualViewFocusRef.current = nextFocus
        setDualViewFocus(nextFocus)
      }

      const nextConfig = getAlignedGenomeConfigForView(
        withNextPreviousSessionGenomes(
          { ...currentConfig, active_species: nextActive },
          [...nextActive, ...nextInactive],
        ),
        'structural_variation',
        nextFocus,
      )
      if (
        !speciesListsEqualByKey(currentConfig?.active_species || [], nextConfig?.active_species || []) ||
        hasGenomeAssignmentChanges(currentConfig, nextConfig)
      ) {
        await handleBrowserConfigChange(nextConfig)
      }
    } finally {
      suppressViewSyncRef.current = false
    }
  }

export async function toggleStructuralVariationPill(ctx, species, source = 'pill') {
    const {
        handleSpeciesPillToggle,
        handleStructuralVariationGenomeOrderChange,
        svAnchorSpecies,
        svSecondSpecies,
        svThirdSpecies,
    } = ctx
    if (!species) return { ok: false, reason: 'missing_species' }
    const key = speciesItemKey(species)
    const anchorKey = svAnchorSpecies ? speciesItemKey(svAnchorSpecies) : ''
    const secondKey = svSecondSpecies ? speciesItemKey(svSecondSpecies) : ''
    const thirdKey = svThirdSpecies ? speciesItemKey(svThirdSpecies) : ''

    if (anchorKey && key === anchorKey) {
      await handleStructuralVariationGenomeOrderChange([], {
        allowEmpty: true,
        deactivateSpecies: [species],
        anchorKey: SV_NO_ANCHOR_KEY,
        secondKey: '',
        thirdKey: '',
        clearRegion: true,
      })
      return { ok: true, deactivated: true }
    }

    if (secondKey && key === secondKey) {
      const promotedThird = svThirdSpecies || null
      await handleStructuralVariationGenomeOrderChange(
        [svAnchorSpecies, promotedThird].filter(Boolean),
        {
          deactivateSpecies: [species],
          anchorKey,
          secondKey: promotedThird ? speciesItemKey(promotedThird) : '',
          thirdKey: '',
        },
      )
      return { ok: true, deactivated: true }
    }

    if (thirdKey && key === thirdKey) {
      await handleStructuralVariationGenomeOrderChange(
        [svAnchorSpecies, svSecondSpecies].filter(Boolean),
        {
          deactivateSpecies: [species],
          anchorKey,
          secondKey,
          thirdKey: '',
        },
      )
      return { ok: true, deactivated: true }
    }

    return handleSpeciesPillToggle(species, source)
  }

export async function applySelectorConfigChange(ctx, configUpdate) {
    const {
        buildFocusFromActive,
        config,
        configRef,
        currentView,
        dualViewFocusRef,
        getAlignedGenomeConfigForView,
        handleBrowserConfigChange,
        inactiveSelectedSpeciesRef,
        setDualViewFocus,
        setInactiveSelectedSpecies,
        suppressViewSyncRef,
    } = ctx
    const currentConfig = configRef.current || config
    const rawConfigWithSystemPlaylists = typeof configUpdate === 'function'
      ? configUpdate(currentConfig)
      : configUpdate
    if (!rawConfigWithSystemPlaylists) return
    const manualBatchAddedKeys = new Set(
      Array.isArray(rawConfigWithSystemPlaylists.__manual_batch_added_keys)
        ? rawConfigWithSystemPlaylists.__manual_batch_added_keys
        : []
    )
    const removedGenomeKeys = Array.isArray(rawConfigWithSystemPlaylists.__removed_genome_keys)
      ? rawConfigWithSystemPlaylists.__removed_genome_keys
      : []
    const {
      __manual_batch_added_keys: _manualBatchAddedKeys,
      __removed_genome_keys: _removedGenomeKeys,
      ...rawNextConfig
    } = rawConfigWithSystemPlaylists

    const previousActive = dedupeSpeciesList(currentConfig?.active_species)
    const previousKeys = new Set(previousActive.map((species) => speciesItemKey(species)))
    let nextActive = dedupeSpeciesList(rawNextConfig?.active_species)
    let nextInactive = dedupeSpeciesList(inactiveSelectedSpeciesRef.current)

    // A removed genome has to leave the selected-but-inactive list before the
    // session snapshot below is rebuilt from it, or it is written straight back
    // and returns on the next launch.
    if (removedGenomeKeys.length > 0) {
      const survivors = nextInactive.filter(
        (species) => !removedGenomeKeys.some((key) => genomeKeysMatch(species, key))
      )
      if (survivors.length !== nextInactive.length) {
        nextInactive = survivors
        setInactiveSelectedSpecies(survivors)
      }
    }

    suppressViewSyncRef.current = true
    try {
      const newlyAdded = nextActive.filter((species) => !previousKeys.has(speciesItemKey(species)))
      if (newlyAdded.length > 0 && (previousActive.length > 0 || manualBatchAddedKeys.size > 0)) {
        // Preserve the current view. A manual batch with no previous selection
        // activates its first genome and appends the rest as selected/inactive.
        const additionsToKeepActive = previousActive.length === 0
          ? newlyAdded.filter((species) => manualBatchAddedKeys.has(speciesItemKey(species))).slice(0, 1)
          : []
        const additionsToKeepActiveKeys = new Set(additionsToKeepActive.map((species) => speciesItemKey(species)))
        const additionsToMakeInactive = newlyAdded.filter(
          (species) => !additionsToKeepActiveKeys.has(speciesItemKey(species))
        )
        const inactiveAdditionKeys = new Set(additionsToMakeInactive.map((species) => speciesItemKey(species)))
        nextActive = nextActive.filter((species) => !inactiveAdditionKeys.has(speciesItemKey(species)))
        for (const species of additionsToMakeInactive) {
          nextInactive = appendUniqueSpecies(nextInactive, species)
        }
        if (additionsToMakeInactive.length > 0) setInactiveSelectedSpecies(nextInactive)
      }

      const nextFocus = buildFocusFromActive(nextActive, dualViewFocusRef.current)
      if (
        nextFocus.primaryKey !== dualViewFocusRef.current.primaryKey ||
        nextFocus.secondaryKey !== dualViewFocusRef.current.secondaryKey
      ) {
        dualViewFocusRef.current = nextFocus
        setDualViewFocus(nextFocus)
      }

      const alignedConfig = getAlignedGenomeConfigForView(
        withNextPreviousSessionGenomes(
          { ...rawNextConfig, active_species: nextActive },
          [...nextActive, ...nextInactive]
        ),
        currentView,
        nextFocus
      )
      await handleBrowserConfigChange(alignedConfig)
    } finally {
      suppressViewSyncRef.current = false
    }
  }

export async function reorderSpeciesPills(ctx, {
    source,
    target,
    sourceKey = '',
    targetKey = '',
    insertPosition = 'before',
  }) {
    const {
        buildFocusFromActive,
        config,
        configRef,
        currentView,
        dualViewFocusRef,
        getAlignedGenomeConfigForView,
        handleBrowserConfigChange,
        hasGenomeAssignmentChanges,
        inactiveSelectedSpeciesRef,
        setDualViewFocus,
        setInactiveSelectedSpecies,
        suppressViewSyncRef,
    } = ctx
    const normalizedSourceKey = sourceKey || speciesItemKey(source)
    const normalizedTargetKey = targetKey || speciesItemKey(target)
    if (!normalizedSourceKey || !normalizedTargetKey || normalizedSourceKey === normalizedTargetKey) return

    const currentConfig = configRef.current || config
    const active = dedupeSpeciesList(currentConfig?.active_species)
    const inactive = dedupeSpeciesList(inactiveSelectedSpeciesRef.current)
    const sourceInActive = active.some((item) => speciesItemKey(item) === normalizedSourceKey)
    const targetInActive = active.some((item) => speciesItemKey(item) === normalizedTargetKey)
    if (!targetInActive) return

    let nextActive = active
    let nextInactive = inactive

    if (sourceInActive) {
      const orderedKeys = active.map((item) => speciesItemKey(item))
      const reorderedKeys = reorderWithInsertPosition(orderedKeys, normalizedSourceKey, normalizedTargetKey, insertPosition)
      if (orderedKeys.join('|') === reorderedKeys.join('|')) return
      const byKey = new Map(active.map((item) => [speciesItemKey(item), item]))
      nextActive = reorderedKeys.map((key) => byKey.get(key)).filter(Boolean)
    } else {
      const sourceSpecies = inactive.find((item) => speciesItemKey(item) === normalizedSourceKey) || source
      if (!sourceSpecies) return
      const targetIndex = active.findIndex((item) => speciesItemKey(item) === normalizedTargetKey)
      if (targetIndex < 0) return
      const insertionIndex = insertPosition === 'after' ? targetIndex + 1 : targetIndex
      nextActive = [...active]
      nextActive.splice(insertionIndex, 0, sourceSpecies)
      nextActive = dedupeSpeciesList(nextActive)
      nextInactive = inactive.filter((item) => speciesItemKey(item) !== normalizedSourceKey)
    }

    const first = nextActive[0] ? speciesItemKey(nextActive[0]) : ''
    const second = nextActive[1] ? speciesItemKey(nextActive[1]) : ''
    const nextFocus = buildFocusFromActive(nextActive, { primaryKey: first, secondaryKey: second })

    suppressViewSyncRef.current = true
    try {
      setInactiveSelectedSpecies(nextInactive)
      if (
        nextFocus.primaryKey !== dualViewFocusRef.current.primaryKey ||
        nextFocus.secondaryKey !== dualViewFocusRef.current.secondaryKey
      ) {
        dualViewFocusRef.current = nextFocus
        setDualViewFocus(nextFocus)
      }

		      const nextConfig = getAlignedGenomeConfigForView(
		        withNextPreviousSessionGenomes(
		          { ...currentConfig, active_species: nextActive },
		          [...nextActive, ...nextInactive]
		        ),
	        currentView,
	        nextFocus
      )
      if (
        !speciesListsEqualByKey(currentConfig?.active_species || [], nextConfig?.active_species || []) ||
        hasGenomeAssignmentChanges(currentConfig, nextConfig)
      ) {
        await handleBrowserConfigChange(nextConfig)
      }
    } finally {
      suppressViewSyncRef.current = false
    }
  }

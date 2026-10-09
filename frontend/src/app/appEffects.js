import { hasFiniteGeneCoords, mergeGeneFocus, normalizeGeneToken } from './geneFocus.js'

// App-level effects: following download tasks so finished genomes reach the
// selector, keeping the browser's reference and target gene focus in step, and
// restoring focus from a resumed session.

export function watchDownloadTasks(ctx) {
    const {
        alignmentInputs,
        alignmentInputsRef,
    } = ctx
    alignmentInputsRef.current = alignmentInputs
  }

export function syncReferenceGeneFocus(ctx) {
    const {
        browserRefGene,
        currentView,
        lastRefFocusKeyRef,
        refLastResolvedQueryRef,
        refResolveInFlightQueryRef,
        resolveInput,
        setAlignment,
        setBrowserRefGene,
        setError,
        setLoadedParams,
        setRefInput,
    } = ctx
    const focusKey = `${normalizeGeneToken(browserRefGene?.id)}|${normalizeGeneToken(browserRefGene?.name)}`
    const focusChanged = lastRefFocusKeyRef.current !== focusKey
    if (lastRefFocusKeyRef.current !== focusKey) {
      lastRefFocusKeyRef.current = focusKey
    }
    if (!browserRefGene) {
      refResolveInFlightQueryRef.current = ''
      refLastResolvedQueryRef.current = ''
      return
    }
    if (focusChanged) {
      const display = browserRefGene.name || browserRefGene.id
      setRefInput(display)
    }

    // In multi-alignment and neighbourhood views, browser focus is already the source
    // of truth, so avoid re-resolving IDs and stomping manual text edits.
    if (currentView === 'alignment' || currentView === 'neighbourhood') {
      return
    }

    // Legacy pairwise flow: new gene selection invalidates displayed alignment.
    setAlignment(null)
    setLoadedParams(null)
    setError(null)
    const query = browserRefGene.id || browserRefGene.name
    const queryNorm = String(query || '').trim().toLowerCase()
    if (!queryNorm) return

    if (
      refResolveInFlightQueryRef.current === queryNorm ||
      refLastResolvedQueryRef.current === queryNorm
    ) {
      return
    }

    refResolveInFlightQueryRef.current = queryNorm
    let cancelled = false
    resolveInput('ref', query).then((resolved) => {
      if (cancelled || !resolved?.gene || !queryNorm) return
      refLastResolvedQueryRef.current = queryNorm
      setBrowserRefGene((prev) => {
        if (!prev || hasFiniteGeneCoords(prev)) return prev
        const prevId = String(prev.id || '').trim().toLowerCase()
        const prevName = String(prev.name || '').trim().toLowerCase()
        const resolvedId = String(resolved.gene.id || '').trim().toLowerCase()
        const resolvedName = String(resolved.gene.name || '').trim().toLowerCase()
        const matches = prevId === queryNorm || prevName === queryNorm || resolvedId === queryNorm || resolvedName === queryNorm
        if (!matches || !hasFiniteGeneCoords(resolved.gene)) return prev
        return mergeGeneFocus(prev, resolved.gene)
      })
    }).finally(() => {
      if (refResolveInFlightQueryRef.current === queryNorm) {
        refResolveInFlightQueryRef.current = ''
      }
    })
    return () => {
      cancelled = true
    }
  }

export function restoreFocusFromSession(ctx) {
    const {
        alignmentGlobalFlankMax,
        alignmentGlobalFlanks,
        alignmentGlobalFlanksLocked,
        alignmentInputs,
        alignmentSidebarCollapsed,
        browserFocusByGenome,
        browserRefGene,
        browserTgtGene,
        config,
        configLoaded,
        currentView,
        dualViewFocus,
        inactiveSelectedSpecies,
        loadedAlignmentBaselineByGenome,
        mainContentNode,
        multiAlignmentResult,
        sessionStateRef,
    } = ctx
    return (
sessionStateRef.current = {
    currentView, config, configLoaded, inactiveSelectedSpecies, dualViewFocus, mainContentNode,
    browserRefGene, browserTgtGene, browserFocusByGenome,
    alignmentInputs, alignmentGlobalFlanks, alignmentGlobalFlanksLocked, alignmentGlobalFlankMax,
    alignmentSidebarCollapsed, multiAlignmentResult, loadedAlignmentBaselineByGenome,
  }
    )
}

export function syncTargetGeneFocus(ctx) {
    const {
        browserTgtGene,
        currentView,
        lastTgtFocusKeyRef,
        resolveInput,
        setAlignment,
        setBrowserTgtGene,
        setError,
        setLoadedParams,
        setTgtInput,
        tgtLastResolvedQueryRef,
        tgtResolveInFlightQueryRef,
    } = ctx
    const focusKey = `${normalizeGeneToken(browserTgtGene?.id)}|${normalizeGeneToken(browserTgtGene?.name)}`
    const focusChanged = lastTgtFocusKeyRef.current !== focusKey
    if (lastTgtFocusKeyRef.current !== focusKey) {
      lastTgtFocusKeyRef.current = focusKey
    }
    if (!browserTgtGene) {
      tgtResolveInFlightQueryRef.current = ''
      tgtLastResolvedQueryRef.current = ''
      return
    }
    if (focusChanged) {
      const display = browserTgtGene.name || browserTgtGene.id
      setTgtInput(display)
    }

    // In multi-alignment and neighbourhood views, browser focus is already the source
    // of truth, so avoid re-resolving IDs and stomping manual text edits.
    if (currentView === 'alignment' || currentView === 'neighbourhood') {
      return
    }

    // Legacy pairwise flow: new gene selection invalidates displayed alignment.
    setAlignment(null)
    setLoadedParams(null)
    setError(null)
    const query = browserTgtGene.id || browserTgtGene.name
    const queryNorm = String(query || '').trim().toLowerCase()
    if (!queryNorm) return

    if (
      tgtResolveInFlightQueryRef.current === queryNorm ||
      tgtLastResolvedQueryRef.current === queryNorm
    ) {
      return
    }

    tgtResolveInFlightQueryRef.current = queryNorm
    let cancelled = false
    resolveInput('tgt', query).then((resolved) => {
      if (cancelled || !resolved?.gene || !queryNorm) return
      tgtLastResolvedQueryRef.current = queryNorm
      setBrowserTgtGene((prev) => {
        if (!prev || hasFiniteGeneCoords(prev)) return prev
        const prevId = String(prev.id || '').trim().toLowerCase()
        const prevName = String(prev.name || '').trim().toLowerCase()
        const resolvedId = String(resolved.gene.id || '').trim().toLowerCase()
        const resolvedName = String(resolved.gene.name || '').trim().toLowerCase()
        const matches = prevId === queryNorm || prevName === queryNorm || resolvedId === queryNorm || resolvedName === queryNorm
        if (!matches || !hasFiniteGeneCoords(resolved.gene)) return prev
        return mergeGeneFocus(prev, resolved.gene)
      })
    }).finally(() => {
      if (tgtResolveInFlightQueryRef.current === queryNorm) {
        tgtResolveInFlightQueryRef.current = ''
      }
    })
    return () => {
      cancelled = true
    }
  }

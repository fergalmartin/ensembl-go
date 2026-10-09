// Navigation requested from outside a Genome Browser panel (another view, a linked
// panel, a tutorial): going to a gene or a location once the panel can resolve it.

export function applyExternalLocationNavigation(ctx) {
    const {
        lastNavigateLocationRef,
        navigateToLocation,
        pendingLocationNavigateRef,
    } = ctx
    return (
pendingLocationNavigateRef.current = Boolean(
        navigateToLocation && navigateToLocation !== lastNavigateLocationRef.current
    )
    )
}

export function applyExternalGeneNavigation(ctx) {
    const {
        fetchTranscripts,
        selectedGene,
        transcriptCache,
    } = ctx
        if (!selectedGene?.id) return
        if (transcriptCache[selectedGene.id]) return
        fetchTranscripts(selectedGene.id)
    }

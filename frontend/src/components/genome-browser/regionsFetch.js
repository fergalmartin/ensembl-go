// Fetching a Genome Browser panel's regions (chromosomes and scaffolds) when it
// becomes active, and choosing the initial locus.

export function fetchPanelRegions(ctx) {
    const {
        geneNavigationRef,
        navigateToGene,
    } = ctx
    return (
geneNavigationRef.current = navigateToGene
    )
}

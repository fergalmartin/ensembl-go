// Polling the state of a genome's gene index while it is being built, so the panel
// can show progress and load genes when it is ready.

export function pollGeneIndexStatus(ctx) {
    const {
        geneIndexReadyRef,
        sawPendingRef,
        setGeneIndexStatus,
    } = ctx
        geneIndexReadyRef.current = false
        sawPendingRef.current = false
        setGeneIndexStatus(null)
    }

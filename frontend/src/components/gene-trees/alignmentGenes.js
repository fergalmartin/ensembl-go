/**
 * The alignment columns' pure parts: their settings, and which leaves become rows. (Kept
 * apart from the fetching in alignmentData.js, so they can be tested without the app.)
 */
export const ALIGNMENT_DEFAULTS = Object.freeze({ region: 'exons', flank: 100, intron_edge: 10, transcript: 'canonical', width: 'm' })
export const FLANK_CHOICES_BP = [0, 50, 100, 200]
export const INTRON_EDGE_CHOICES = [5, 10, 20]

/** The linked leaves of what is on show, as the backend's genes: leaf id → gene. */
export function alignmentGenes(nodes, links) {
  const out = new Map()
  for (const node of nodes || []) {
    if (!node.leaf) continue
    const link = links?.[node.id]
    if (link?.status !== 'linked' || !link.assembly || !link.gene?.id) continue
    out.set(node.id, { assembly: link.assembly, gene_id: link.gene.id, transcript_id: link.transcript_id || null })
  }
  return out
}

export const geneKey = gene => `${gene.assembly}:${gene.gene_id}`

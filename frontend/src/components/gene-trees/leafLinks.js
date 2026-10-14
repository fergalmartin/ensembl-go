/** A graft keeps its own collection; older saved nodes use the fragment's source. */
export function leafLinkRequest(node, source) {
  return {
    collection_id: node.srcTree ? node.srcTree.split(':')[0] : source?.collectionId || null,
    leaf: node.leaf,
  }
}

export const leafLinkKey = (node, source) => JSON.stringify(leafLinkRequest(node, source))

/** Repeated copies of a gene share one lookup, independent of forest node numbering. */
export function layerLinkRequests(layers) {
  const unique = new Map()
  for (const layer of layers) {
    for (const fragment of layer.fragments) {
      for (const node of fragment.nodes) {
        if (node.leaf) unique.set(leafLinkKey(node, fragment.source), leafLinkRequest(node, fragment.source))
      }
    }
  }
  return [...unique.entries()]
}

/** Files and annotation readiness matter; selecting a genome or changing its colour does not. */
export function localGenomeLinkKey(genomes, outputDir) {
  return JSON.stringify([outputDir, genomes.map(g => ({
    assembly: g.assembly || g.gca, species_key: g.species_key, scientific_name: g.scientific_name,
    provider: g.provider, files: g.files,
  }))])
}

/** Resolve bounded batches and publish only a complete round; pending proteins get another round. */
export async function resolveLayerLinks(requests, fetchLinks, signal) {
  const links = new Map()
  let pending = false
  for (let start = 0; start < requests.length; start += 1000) {
    const batch = requests.slice(start, start + 1000)
    const result = await fetchLinks('/resolve-links', { leaves: batch.map(([, leaf]) => leaf) }, signal)
    for (let i = 0; i < batch.length; i++) {
      const link = result.links[i]
      if (!link) throw new Error('A saved gene was missing from the genome-link response')
      links.set(batch[i][0], link)
    }
    pending ||= result.pending
  }
  return { links, pending }
}

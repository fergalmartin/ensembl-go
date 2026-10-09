// Per-genome gene focus records: merging updates and comparing them. Pure functions.

export function hasFiniteGeneCoords(gene) {
  return Boolean(gene) &&
    Number.isFinite(Number(gene.start)) &&
    Number.isFinite(Number(gene.end)) &&
    String(gene.chrom || '').trim().length > 0
}

export function geneFocusSignature(gene) {
  if (!gene) return ''
  return [
    String(gene.id || '').trim(),
    String(gene.name || '').trim(),
    String(gene.chrom || '').trim(),
    Number.isFinite(Number(gene.start)) ? Number(gene.start) : '',
    Number.isFinite(Number(gene.end)) ? Number(gene.end) : '',
    String(gene.strand || '').trim(),
    String(gene.biotype || '').trim(),
  ].join('|')
}

export function mergeGeneFocus(prevGene, nextGene) {
  if (!nextGene) return null
  if (!prevGene) return nextGene
  const prevId = String(prevGene.id || '').trim()
  const nextId = String(nextGene.id || '').trim()
  const sameId = prevId && nextId && prevId === nextId
  if (!sameId) return nextGene

  const prevHasCoords = hasFiniteGeneCoords(prevGene)
  const nextHasCoords = hasFiniteGeneCoords(nextGene)
  if (prevHasCoords && !nextHasCoords) return prevGene
  const merged = { ...prevGene, ...nextGene }
  return geneFocusSignature(prevGene) === geneFocusSignature(merged) ? prevGene : merged
}

export function normalizeGeneToken(value) {
  return String(value || '').trim().toLowerCase()
}

export function updateGeneFocusMapEntry(prevMap, genomeKey, nextGene, fallbackGene = null) {
  const key = String(genomeKey || '').trim()
  if (!key) return prevMap

  const currentMap = prevMap || {}
  if (!nextGene) {
    if (!Object.prototype.hasOwnProperty.call(currentMap, key)) return prevMap
    const nextMap = { ...currentMap }
    delete nextMap[key]
    return nextMap
  }

  const merged = mergeGeneFocus(currentMap[key] || fallbackGene || null, nextGene)
  if (geneFocusSignature(currentMap[key] || null) === geneFocusSignature(merged)) {
    return prevMap
  }
  return {
    ...currentMap,
    [key]: merged,
  }
}

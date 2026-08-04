const INDEX_DEPENDENT_VIEWS = new Set([
  'alignment',
  'feature_explorer',
  'genome_browser',
  'homology',
  'neighbourhood',
  'stats',
  'structural_variation',
])

export function shouldAutoEnsurePrimaryIndex(viewId) {
  return INDEX_DEPENDENT_VIEWS.has(String(viewId || '').trim())
}

export function primaryGenomeForIndex(activeSpecies, refGff = '') {
  const candidates = (Array.isArray(activeSpecies) ? activeSpecies : [])
    .filter((species) => Boolean(String(species?.files?.gff3 || '').trim()))
  if (candidates.length === 0) return null

  const preferredGff = String(refGff || '').trim()
  if (preferredGff) {
    const preferred = candidates.find(
      (species) => String(species?.files?.gff3 || '').trim() === preferredGff,
    )
    if (preferred) return preferred
  }
  return candidates[0]
}

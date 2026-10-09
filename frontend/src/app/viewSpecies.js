// Choosing genomes for particular views: the structural-variation reference/target
// trio from known assembly aliases, and the neighbourhood view's genome pairs and
// tracks. Pure functions.
import { dedupeSpeciesList, speciesItemKey } from './genomeLists.js'

export const NEIGHBOURHOOD_FLANK_WINDOW_SIZE = 100

export const SV_REF_GRCH38_ALIASES = [
  'grch38',
  'grch38p14',
  'gca00000140529',
  'gcf00000140540',
]

export const SV_TARGET_HG00438_ALIASES = [
  'hg00438',
  'hg00438pathprcf2',
  'gca0184725952',
]

export const SV_TARGET_HG00733_ALIASES = [
  'hg007332',
  'hg00733mat',
  'hg00733mathprcf2',
  'gca0185069752',
  'gca0185069753',
  '0fb76cdf6c6b4c20beef7f7d4151651b',
]

export const SV_NO_ANCHOR_KEY = '__sv_no_anchor__'

export function normalizeSvSpeciesToken(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}

export function collectSvSpeciesTokens(species) {
  if (!species) return []
  const rawValues = [
    species?.assembly_name,
    species?.assembly,
    species?.gca,
    species?.accession,
    species?.name,
    species?.key,
    species?.scientific_name,
    species?.common_name,
  ]
  const tokens = []
  for (const value of rawValues) {
    const normalized = normalizeSvSpeciesToken(value)
    if (!normalized || tokens.includes(normalized)) continue
    tokens.push(normalized)
  }
  return tokens
}

export function speciesMatchesSvAliases(species, aliases) {
  const tokens = collectSvSpeciesTokens(species)
  return aliases.some((alias) => tokens.some((token) => token.includes(alias)))
}

export function resolveStructuralVariationTrioSpecies(activeSpecies) {
  const active = dedupeSpeciesList(activeSpecies)
  if (active.length !== 3) return null

  const reference = active.find((species) => speciesMatchesSvAliases(species, SV_REF_GRCH38_ALIASES)) || null
  const secondary = active.find((species) => speciesMatchesSvAliases(species, SV_TARGET_HG00438_ALIASES)) || null
  const third = active.find((species) => speciesMatchesSvAliases(species, SV_TARGET_HG00733_ALIASES)) || null

  if (!reference || !secondary || !third) return null

  const usedKeys = new Set([speciesItemKey(reference), speciesItemKey(secondary), speciesItemKey(third)])
  if (usedKeys.size !== 3) return null

  return { reference, secondary, third }
}

export function buildNeighbourhoodPairKey(refGenomeKey, targetGenomeKey) {
  const ref = String(refGenomeKey || '').trim()
  const tgt = String(targetGenomeKey || '').trim()
  return ref && tgt ? `${ref}__${tgt}` : ''
}

export function mergeNeighbourhoodTrack(prevTrack, incomingGenes, centerGeneId, requestGeneId, windowSize = NEIGHBOURHOOD_FLANK_WINDOW_SIZE) {
  const genes = Array.isArray(incomingGenes) ? incomingGenes.filter((gene) => gene?.id) : []
  const centerId = String(centerGeneId || '').trim()
  const requestId = String(requestGeneId || centerId).trim()
  const incomingCenter = genes.find((gene) => String(gene?.id || '').trim() === centerId) || null
  const incomingChrom = String(incomingCenter?.chrom || genes[0]?.chrom || '').trim()
  const prevGenes = Array.isArray(prevTrack?.genes) ? prevTrack.genes.filter((gene) => gene?.id) : []
  const prevCenter = prevGenes.find((gene) => String(gene?.id || '').trim() === String(prevTrack?.centerGeneId || '').trim()) || null
  const prevChrom = String(prevCenter?.chrom || prevGenes[0]?.chrom || '').trim()
  const canAccumulate = Boolean(incomingChrom && prevChrom && incomingChrom === prevChrom)
  const sourceGenes = canAccumulate ? [...prevGenes, ...genes] : genes
  const byId = new Map()

  for (const gene of sourceGenes) {
    const id = String(gene?.id || '').trim()
    if (!id) continue
    byId.set(id, {
      ...gene,
      is_focal: id === centerId,
    })
  }

  if (centerId && byId.has(centerId)) {
    const centerGene = byId.get(centerId)
    byId.set(centerId, { ...centerGene, is_focal: true })
  }

  const mergedGenes = [...byId.values()].sort((a, b) => {
    const chromCompare = String(a?.chrom || '').localeCompare(String(b?.chrom || ''))
    if (chromCompare !== 0) return chromCompare
    const aStart = Number(a?.start || 0)
    const bStart = Number(b?.start || 0)
    if (aStart !== bStart) return aStart - bStart
    return String(a?.id || '').localeCompare(String(b?.id || ''))
  })

  return {
    genes: mergedGenes,
    centerGeneId: centerId,
    requestGeneId: requestId,
    windowSize,
  }
}

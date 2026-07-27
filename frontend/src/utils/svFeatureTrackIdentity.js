import { getGenomeKey } from './genomeIdentity.js'

function explicitGenomeId(species) {
  return String(getGenomeKey(species) || '').trim()
}

/**
 * Resolve every genome used by an SV feature band to an active-species key.
 *
 * The `reference` and `target` aliases point at mutable legacy config slots and
 * are therefore only safe as compatibility fallbacks when a species record is
 * genuinely unavailable. Canonical transcripts (GF/GR) and sequence (SL) must
 * share these resolved IDs or the lanes can silently read different genomes.
 */
export function resolveSvFeatureTrackGenomeIds({
  referenceSpecies = null,
  topSpecies = null,
  bottomSpecies = null,
  bottomGenomeId = '',
} = {}) {
  const explicitBottom = String(bottomGenomeId || '').trim() || explicitGenomeId(bottomSpecies)
  return {
    reference: explicitGenomeId(referenceSpecies) || 'reference',
    top: explicitGenomeId(topSpecies) || 'target',
    bottom: bottomSpecies || bottomGenomeId ? explicitBottom : '',
  }
}

export function resolveSvFeatureWindowChrom(...candidates) {
  for (const candidate of candidates) {
    const value = typeof candidate === 'string' ? candidate : candidate?.chrom
    const chrom = String(value || '').trim()
    if (chrom) return chrom
  }
  return ''
}

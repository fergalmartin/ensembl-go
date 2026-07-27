export function normalizeSvCatalogToken(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function uniqueTokens(values) {
  const out = []
  const seen = new Set()
  for (const value of values) {
    const token = normalizeSvCatalogToken(value)
    if (!token || seen.has(token)) continue
    seen.add(token)
    out.push(token)
  }
  return out
}

export function speciesGenomeKey(species) {
  if (!species) return ''
  return String(
    species.key
    || species.genome_key
    || `${species.provider || ''}:${species.species_key || ''}:${species.assembly || species.gca || species.accession || species.assembly_name || ''}`,
  )
}

export function collectSpeciesGenomeTokens(species) {
  if (!species) return []
  const values = [
    species.key,
    species.genome_key,
    speciesGenomeKey(species),
    species.provider,
    species.species_key,
    species.assembly,
    species.gca,
    species.accession,
    species.assembly_name,
    species.name,
    species.display_name,
    species.common_name,
    species.scientific_name,
    ...(species.aliases || []),
    ...(species.equivalent_accessions || []),
  ]
  return uniqueTokens(values)
}

export function collectSpeciesAssemblyTokens(species) {
  if (!species) return []
  const values = [
    species.key,
    species.genome_key,
    speciesGenomeKey(species),
    species.assembly,
    species.gca,
    species.accession,
    species.assembly_name,
    ...(species.aliases || []),
    ...(species.equivalent_accessions || []),
  ]
  return uniqueTokens(values)
}

export function collectCatalogGenomeTokens(genome) {
  if (!genome) return []
  const values = [
    genome.id,
    genome.genome_key,
    genome.provider,
    genome.species_key,
    genome.assembly,
    genome.gca,
    genome.accession,
    genome.assembly_name,
    genome.display_name,
    genome.common_name,
    genome.scientific_name,
    ...(genome.aliases || []),
    ...(genome.equivalent_accessions || []),
  ]
  return uniqueTokens(values)
}

export function collectCatalogAssemblyTokens(genome) {
  if (!genome) return []
  const values = [
    genome.id,
    genome.genome_key,
    genome.assembly,
    genome.gca,
    genome.accession,
    genome.assembly_name,
    ...(genome.aliases || []),
    ...(genome.equivalent_accessions || []),
  ]
  return uniqueTokens(values)
}

function tokenSetsMatch(leftTokens, rightTokens) {
  if (!leftTokens.length || !rightTokens.length) return false
  const rightSet = new Set(rightTokens)
  if (leftTokens.some((token) => rightSet.has(token))) return true
  return leftTokens.some((left) => {
    if (left.length < 5) return false
    return rightTokens.some((right) => right.length >= 5 && (left.includes(right) || right.includes(left)))
  })
}

export function catalogGenomeMatchesSpecies(catalogGenome, species) {
  return tokenSetsMatch(
    collectCatalogAssemblyTokens(catalogGenome),
    collectSpeciesAssemblyTokens(species),
  )
}

export function resolveCatalogGenomeForSpecies(catalog, species) {
  const genomes = Array.isArray(catalog?.genomes) ? catalog.genomes : []
  return genomes.find((genome) => catalogGenomeMatchesSpecies(genome, species)) || null
}

export function findSvAlignment(catalog, anchorSpecies, targetSpecies, options = {}) {
  if (!anchorSpecies || !targetSpecies) return null
  const requireSupported = Boolean(options.requireSupported)
  const alignments = Array.isArray(catalog?.alignments) ? catalog.alignments : []
  return alignments.find((alignment) => {
    if (requireSupported && !alignment?.supported) return false
    return catalogGenomeMatchesSpecies(alignment.reference_genome, anchorSpecies)
      && catalogGenomeMatchesSpecies(alignment.target_genome, targetSpecies)
  }) || null
}

export function getOutgoingSvAlignments(catalog, anchorSpecies, options = {}) {
  if (!anchorSpecies) return []
  const requireSupported = Boolean(options.requireSupported)
  const alignments = Array.isArray(catalog?.alignments) ? catalog.alignments : []
  return alignments.filter((alignment) => {
    if (requireSupported && !alignment?.supported) return false
    return catalogGenomeMatchesSpecies(alignment.reference_genome, anchorSpecies)
  })
}

function dedupeSpeciesList(speciesList) {
  const out = []
  const seen = new Set()
  for (const species of Array.isArray(speciesList) ? speciesList : []) {
    const key = speciesGenomeKey(species)
    if (!species || !key || seen.has(key)) continue
    seen.add(key)
    out.push(species)
  }
  return out
}

function resolveAlignmentGenomeState(genome, knownSpecies, activeKeys, selectedKeys) {
  const species = knownSpecies.find((item) => catalogGenomeMatchesSpecies(genome, item)) || genome?.local_species || null
  const key = species ? speciesGenomeKey(species) : ''
  return {
    genome,
    species,
    speciesKey: key,
    isActive: Boolean(key && activeKeys.has(key)),
    isSelected: Boolean(key && selectedKeys.has(key)),
    isLocal: Boolean(species),
    isDownloadable: Boolean(!species && genome?.downloadable),
  }
}

export function buildAvailableSvAlignmentRows(catalog, activeSpecies = [], inactiveSpecies = []) {
  const catalogLocalSpecies = []
  for (const genome of catalog?.genomes || []) {
    if (genome?.local_species) catalogLocalSpecies.push(genome.local_species)
  }
  const active = dedupeSpeciesList(activeSpecies)
  const selected = dedupeSpeciesList([...active, ...(inactiveSpecies || [])])
  const knownSpecies = dedupeSpeciesList([...selected, ...catalogLocalSpecies])
  const activeKeys = new Set(active.map((species) => speciesGenomeKey(species)))
  const selectedKeys = new Set(selected.map((species) => speciesGenomeKey(species)))
  const alignments = Array.isArray(catalog?.alignments) ? catalog.alignments : []

  return alignments.map((alignment, index) => {
    const reference = resolveAlignmentGenomeState(alignment?.reference_genome || {}, knownSpecies, activeKeys, selectedKeys)
    const target = resolveAlignmentGenomeState(alignment?.target_genome || {}, knownSpecies, activeKeys, selectedKeys)
    const supported = Boolean(alignment?.supported)
    const missingFiles = Array.isArray(alignment?.missing_files) ? alignment.missing_files : []
    const regionCount = Array.isArray(alignment?.reference_regions) ? alignment.reference_regions.length : 0
    const hasDownloadableGenome = reference.isDownloadable || target.isDownloadable
    const hasUnavailableGenome = (!reference.isLocal && !reference.isDownloadable)
      || (!target.isLocal && !target.isDownloadable)
    const status = !supported
      ? 'missing_files'
      : (reference.isLocal && target.isLocal
        ? 'usable'
        : (hasDownloadableGenome ? 'downloadable' : 'unavailable'))

    return {
      id: String(alignment?.id || alignment?.alignment_id || `alignment-${index}`),
      alignment,
      reference,
      target,
      supported,
      missingFiles,
      regionCount,
      status,
      hasUnavailableGenome,
      canUse: supported && reference.isLocal && target.isLocal,
      canDownloadReference: supported && reference.isDownloadable,
      canDownloadTarget: supported && target.isDownloadable,
    }
  })
}

export function getSvGenomeDisplayName(genome) {
  return String(
    genome?.display_name
    || genome?.assembly_name
    || genome?.assembly
    || genome?.accession
    || genome?.id
    || 'Genome',
  )
}

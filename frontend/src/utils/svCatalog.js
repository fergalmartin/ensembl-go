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

function collectAssemblyIdentityAliases(record) {
  if (!record) return []
  const weakTokens = new Set(uniqueTokens([
    record.provider,
    record.species_key,
    record.display_name,
    record.common_name,
    record.scientific_name,
  ]))
  return (record.aliases || []).filter((value) => {
    const token = normalizeSvCatalogToken(value)
    return Boolean(token && !weakTokens.has(token))
  })
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
    ...collectAssemblyIdentityAliases(species),
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
    ...collectAssemblyIdentityAliases(genome),
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

export function getSvAlignmentsForPair(catalog, anchorSpecies, targetSpecies, options = {}) {
  if (!anchorSpecies || !targetSpecies) return []
  const requireSupported = Boolean(options.requireSupported)
  const alignments = Array.isArray(catalog?.alignments) ? catalog.alignments : []
  return alignments.filter((alignment) => {
    if (requireSupported && !alignment?.supported) return false
    return catalogGenomeMatchesSpecies(alignment.reference_genome, anchorSpecies)
      && catalogGenomeMatchesSpecies(alignment.target_genome, targetSpecies)
  })
}

export function findSvAlignment(catalog, anchorSpecies, targetSpecies, options = {}) {
  const preferredId = String(options.preferredAlignmentId || '')
  const matches = getSvAlignmentsForPair(catalog, anchorSpecies, targetSpecies, options)
  if (preferredId) {
    const preferred = matches.find((alignment) => String(alignment?.id || '') === preferredId)
    if (preferred) return preferred
  }
  return matches[0] || null
}

// Alignments between the same two assemblies, whichever way round they run. The
// backend supplies pair_id for records that came from a config; the fallback keeps
// scanned and legacy records grouped too.
function svPairKey(alignment) {
  const declared = String(alignment?.pair_id || '')
  if (declared) return declared
  return [
    normalizeSvCatalogToken(getSvGenomeAccessionToken(alignment?.reference_genome)),
    normalizeSvCatalogToken(getSvGenomeAccessionToken(alignment?.target_genome)),
  ].sort().join('__')
}

function getSvGenomeAccessionToken(genome) {
  return genome?.accession || genome?.assembly || genome?.gca || genome?.assembly_name || ''
}

export function buildSvPairIndex(catalog) {
  const alignments = Array.isArray(catalog?.alignments) ? catalog.alignments : []
  const pairs = new Map()
  const genomeIdsByPair = new Map()
  for (const alignment of alignments) {
    const key = svPairKey(alignment)
    if (!key) continue
    if (!pairs.has(key)) {
      pairs.set(key, { id: key, genomes: [], alignments: [] })
      genomeIdsByPair.set(key, new Set())
    }
    const pair = pairs.get(key)
    const seenGenomes = genomeIdsByPair.get(key)
    pair.alignments.push(alignment)
    for (const genome of [alignment?.reference_genome, alignment?.target_genome]) {
      // Identity, not `id`: catalog genomes always carry one, but records reaching
      // here from a scan or a hand-written config may not.
      const identity = String(genome?.id || '') || normalizeSvCatalogToken(getSvGenomeAccessionToken(genome))
      if (!identity || seenGenomes.has(identity)) continue
      seenGenomes.add(identity)
      pair.genomes.push(genome)
    }
  }
  return Array.from(pairs.values())
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

/** Suffix a genome option with why it can or cannot be used.
 *
 * The three states a dropdown entry can be in:
 * - `selected`  already in the top bar; pick it and it is used straight away.
 * - `add`       downloaded, but not in the top bar; picking it adds it there.
 * - `missing`   no local data, so nothing can be drawn for it. Listed but not
 *               selectable, because seeing why a config's genome cannot be used is
 *               more useful than the genome silently not appearing at all.
 */
export function formatSvGenomeOptionLabel(option) {
  const suffixes = []
  if (option?.state === 'add') suffixes.push('add')
  if (option?.state === 'missing') suffixes.push(option?.genome?.downloadable ? 'not downloaded' : 'missing')
  if (option?.supported === false) suffixes.push('missing files')
  return suffixes.length ? `${option.label} (${suffixes.join(', ')})` : String(option?.label || '')
}

/** Build the option list for a genome dropdown.
 *
 * Genomes arriving from a loaded config are included even when they are not in the
 * top bar -- otherwise loading a config appears to do nothing, because the view can
 * only offer what is already selected.
 */
export function buildSvGenomeOptions(genomes, knownSpecies, selectedKeys, activeKeys, options = {}) {
  // The caller supplies the key scheme. The SV view keys selection on
  // getGenomeKey, which is not the same string speciesGenomeKey produces, and an
  // option keyed one way against a selection set keyed the other never matches.
  const keyForSpecies = options.keyForSpecies || speciesGenomeKey
  const labelForSpecies = options.labelForSpecies || getSvGenomeDisplayName
  const labelForGenome = options.labelForGenome || getSvGenomeDisplayName
  const selected = selectedKeys instanceof Set ? selectedKeys : new Set(selectedKeys || [])
  const active = activeKeys instanceof Set ? activeKeys : new Set(activeKeys || [])
  const out = []
  const seen = new Set()

  for (const genome of genomes || []) {
    const identity = String(genome?.id || '') || normalizeSvCatalogToken(getSvGenomeAccessionToken(genome))
    if (!identity || seen.has(identity)) continue
    seen.add(identity)
    const species = (knownSpecies || []).find((item) => catalogGenomeMatchesSpecies(genome, item))
      || genome?.local_species
      || null
    const speciesKey = species ? String(keyForSpecies(species) || '') : ''
    const state = species && selected.has(speciesKey)
      ? 'selected'
      : ((species || genome?.local) ? 'add' : 'missing')
    out.push({
      value: species ? `species:${speciesKey}` : `catalog:${identity}`,
      label: species ? labelForSpecies(species) : labelForGenome(genome),
      species,
      genome,
      speciesKey,
      state,
      isSelected: state === 'selected',
      isActive: Boolean(speciesKey && active.has(speciesKey)),
      disabled: state === 'missing',
    })
  }

  return out.sort(compareSvGenomeOptions)
}

export function compareSvGenomeOptions(left, right) {
  const rank = { selected: 0, add: 1, missing: 2 }
  const leftRank = rank[left?.state] ?? 3
  const rightRank = rank[right?.state] ?? 3
  if (leftRank !== rightRank) return leftRank - rightRank
  return String(left?.label || '').localeCompare(String(right?.label || ''))
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

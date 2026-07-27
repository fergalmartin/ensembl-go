export const DEFAULT_PROVIDER = 'ensembl'
export const NCBI_PROVIDER = 'ncbi'
export const MANUAL_PROVIDER = 'manual'
export const DATASET_SELECTION_SEPARATOR = '::dataset::'

export function normalizeGenomeProvider(itemOrProvider, options = {}) {
  const explicit = typeof itemOrProvider === 'string'
    ? itemOrProvider
    : itemOrProvider?.provider
  const raw = String(explicit || '').trim().toLowerCase()
  if (raw) return raw
  const isManual = Boolean(options?.isManual ?? itemOrProvider?.is_manual)
  return isManual ? MANUAL_PROVIDER : DEFAULT_PROVIDER
}

export function inferSourceDatabase(providerOrItem, assemblyValue = '') {
  const provider = normalizeGenomeProvider(providerOrItem)
  const assembly = String(
    typeof providerOrItem === 'object' && providerOrItem !== null
      ? (providerOrItem?.assembly || providerOrItem?.gca || assemblyValue || '')
      : (assemblyValue || '')
  ).trim().toUpperCase()
  if (provider === DEFAULT_PROVIDER) return 'Ensembl'
  if (provider === MANUAL_PROVIDER) return 'Manual'
  if (provider === NCBI_PROVIDER) {
    if (assembly.startsWith('GCF_')) return 'RefSeq'
    if (assembly.startsWith('GCA_')) return 'GenBank'
    return 'NCBI'
  }
  return provider.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase())
}

export function normalizeGenomeSourceDatabase(item) {
  const raw = String(item?.source_database || '').trim()
  if (raw) return raw
  return inferSourceDatabase(item)
}

export function getAssemblyAccession(item) {
  return String(item?.assembly || item?.gca || item?.assembly_name || '').trim()
}

export function getLegacyGenomeKey(item) {
  const speciesKey = String(item?.species_key || '').trim()
  const assembly = getAssemblyAccession(item)
  if (!speciesKey || !assembly) return ''
  return `${speciesKey}::${assembly}`
}

export function parseGenomeKey(value, defaultProvider = DEFAULT_PROVIDER) {
  const token = stripDatasetReleaseFromSelectionKey(String(value || '').trim())
  if (!token) return {
    provider: normalizeGenomeProvider(defaultProvider),
    species_key: '',
    assembly: '',
  }
  const parts = token.split('::')
  if (parts.length >= 3) {
    return {
      provider: normalizeGenomeProvider(parts[0]),
      species_key: String(parts[1] || '').trim(),
      assembly: String(parts.slice(2).join('::') || '').trim(),
    }
  }
  if (parts.length === 2) {
    return {
      provider: normalizeGenomeProvider(defaultProvider),
      species_key: String(parts[0] || '').trim(),
      assembly: String(parts[1] || '').trim(),
    }
  }
  return {
    provider: normalizeGenomeProvider(defaultProvider),
    species_key: '',
    assembly: token,
  }
}

export function buildGenomeKey(provider, speciesKey, assembly, options = {}) {
  const normalizedProvider = normalizeGenomeProvider(provider, options)
  const normalizedSpeciesKey = String(speciesKey || '').trim()
  const normalizedAssembly = String(assembly || '').trim()
  if (!normalizedSpeciesKey || !normalizedAssembly) return ''
  return `${normalizedProvider}::${normalizedSpeciesKey}::${normalizedAssembly}`
}

export function getDatasetReleaseKey(item) {
  if (!item) return ''
  if (typeof item === 'string') return datasetReleaseKeyFromSelectionKey(item)
  return String(
    item?.dataset_release_key ||
    datasetReleaseKeyFromSelectionKey(item?.selection_key || item?.key || item?.genome_key || '') ||
    ''
  ).trim()
}

export function stripDatasetReleaseFromSelectionKey(value) {
  const token = String(value || '').trim()
  const idx = token.indexOf(DATASET_SELECTION_SEPARATOR)
  return idx >= 0 ? token.slice(0, idx) : token
}

export function datasetReleaseKeyFromSelectionKey(value) {
  const token = String(value || '').trim()
  const idx = token.indexOf(DATASET_SELECTION_SEPARATOR)
  return idx >= 0 ? token.slice(idx + DATASET_SELECTION_SEPARATOR.length).trim() : ''
}

export function buildDatasetSelectionKey(assemblyKey, datasetReleaseKey = '') {
  const base = stripDatasetReleaseFromSelectionKey(assemblyKey)
  const release = String(datasetReleaseKey || '').trim()
  if (!base) return ''
  return release ? `${base}${DATASET_SELECTION_SEPARATOR}${release}` : base
}

export function getAssemblyGenomeKey(item) {
  if (typeof item === 'string') return stripDatasetReleaseFromSelectionKey(item)
  const canonical = buildGenomeKey(
    item?.provider,
    item?.species_key,
    getAssemblyAccession(item),
    { isManual: Boolean(item?.is_manual) }
  )
  if (canonical) return canonical
  return stripDatasetReleaseFromSelectionKey(item?.assembly_key || item?.key || item?.genome_key || item?.selection_key || '')
}

export function getGenomeKey(item) {
  if (typeof item === 'string') return String(item || '').trim()
  const explicit = String(item?.selection_key || '').trim()
  if (explicit) return explicit
  const assemblyKey = getAssemblyGenomeKey(item)
  const releaseKey = getDatasetReleaseKey(item)
  const selectionKey = buildDatasetSelectionKey(assemblyKey, releaseKey)
  if (selectionKey) return selectionKey
  return String(item?.key || item?.genome_key || '').trim()
}

export function genomeKeyCandidates(item) {
  const keys = []
  const key = getGenomeKey(item)
  if (key) keys.push(key)
  const assemblyKey = getAssemblyGenomeKey(item)
  if (assemblyKey && !keys.includes(assemblyKey)) keys.push(assemblyKey)
  const legacy = getLegacyGenomeKey(item)
  if (legacy && !keys.includes(legacy)) keys.push(legacy)
  return keys
}

export function genomeKeyTokenCandidates(value, defaultProvider = DEFAULT_PROVIDER) {
  const token = String(value || '').trim()
  if (!token) return []
  const candidates = []
  const push = (entry) => {
    const normalized = String(entry || '').trim()
    if (!normalized || candidates.includes(normalized)) return
    candidates.push(normalized)
  }
  push(token)
  const releaseKey = datasetReleaseKeyFromSelectionKey(token)
  const assemblyToken = stripDatasetReleaseFromSelectionKey(token)
  if (assemblyToken && assemblyToken !== token) push(assemblyToken)
  const parsed = parseGenomeKey(token, defaultProvider)
  if (parsed.species_key && parsed.assembly) {
    const assemblyKey = buildGenomeKey(parsed.provider, parsed.species_key, parsed.assembly)
    push(assemblyKey)
    if (releaseKey) push(buildDatasetSelectionKey(assemblyKey, releaseKey))
    push(`${parsed.species_key}::${parsed.assembly}`)
    push(parsed.assembly)
    return candidates
  }
  if (parsed.assembly) {
    push(parsed.assembly)
  }
  return candidates
}

function genomeKeyLikeCandidates(value) {
  if (!value) return []
  if (typeof value === 'string') return genomeKeyTokenCandidates(value)
  const candidates = []
  const push = (entry) => {
    const normalized = String(entry || '').trim()
    if (!normalized || candidates.includes(normalized)) return
    candidates.push(normalized)
  }
  for (const key of genomeKeyCandidates(value)) push(key)
  for (const key of genomeKeyTokenCandidates(value?.key)) push(key)
  for (const key of genomeKeyTokenCandidates(value?.selection_key)) push(key)
  push(getAssemblyAccession(value))
  return candidates
}

export function genomeKeysMatch(left, right) {
  const leftRelease = getDatasetReleaseKey(left)
  const rightRelease = getDatasetReleaseKey(right)
  const leftSelection = typeof left === 'string' ? String(left || '').trim() : getGenomeKey(left)
  const rightSelection = typeof right === 'string' ? String(right || '').trim() : getGenomeKey(right)
  if (leftRelease && rightRelease) {
    return Boolean(leftSelection && rightSelection && leftSelection === rightSelection)
  }
  const leftCandidates = genomeKeyLikeCandidates(left)
  const rightCandidates = genomeKeyLikeCandidates(right)
  if (leftCandidates.length === 0 || rightCandidates.length === 0) return false
  const rightSet = new Set(rightCandidates)
  return leftCandidates.some((candidate) => rightSet.has(candidate))
}

export function genomeKeyMatchesItem(item, genomeKey) {
  return genomeKeysMatch(item, genomeKey)
}

export function normalizeGenomeRecord(item) {
  const assembly = getAssemblyAccession(item)
  const provider = normalizeGenomeProvider(item)
  const sourceDatabase = normalizeGenomeSourceDatabase({ ...item, assembly, provider })
  const assemblyKey = buildGenomeKey(provider, item?.species_key, assembly, { isManual: Boolean(item?.is_manual) }) ||
    getAssemblyGenomeKey(item)
  const datasetReleaseKey = String(item?.dataset_release_key || item?.active_dataset_release_key || datasetReleaseKeyFromSelectionKey(item?.selection_key || item?.key || '') || '').trim()
  const selectionKey = String(item?.selection_key || buildDatasetSelectionKey(assemblyKey, datasetReleaseKey) || item?.key || item?.genome_key || '').trim()
  const datasetReleaseDate = String(item?.dataset_release_date || '').trim()
  const datasetReleaseLabel = String(item?.dataset_release_label || '').trim()
  const datasetReleaseShortLabel = String(item?.dataset_release_short_label || '').trim() ||
    formatDatasetReleaseShortLabel({ key: datasetReleaseKey, date: datasetReleaseDate, label: datasetReleaseLabel, source: item?.dataset_release_source })
  return {
    ...item,
    provider,
    source_database: sourceDatabase,
    assembly,
    gca: String(item?.gca || assembly || '').trim(),
    assembly_key: assemblyKey,
    dataset_release_key: datasetReleaseKey,
    dataset_release_source: String(item?.dataset_release_source || '').trim(),
    dataset_release_date: datasetReleaseDate,
    dataset_release_label: datasetReleaseLabel,
    dataset_release_short_label: datasetReleaseShortLabel,
    selection_key: selectionKey,
  }
}

export function formatDatasetReleaseShortLabel(releaseOrItem) {
  const source = String(releaseOrItem?.source || releaseOrItem?.dataset_release_source || '').trim().toLowerCase()
  const rawDate = String(releaseOrItem?.date || releaseOrItem?.dataset_release_date || '').trim()
  const rawLabel = String(releaseOrItem?.label || releaseOrItem?.dataset_release_label || '').trim()
  if (source === 'custom') return rawLabel || (rawDate ? `custom ${rawDate.replace(/_/g, '-')}` : 'custom')
  if (rawDate && rawDate !== 'unknown') return rawDate.replace(/_/g, '-')
  if (rawLabel) return rawLabel.replace(/^ensembl\s+/i, '').replace(/^refseq\s+/i, '')
  const key = String(releaseOrItem?.key || releaseOrItem?.dataset_release_key || '').trim()
  const keyDate = key.split('/').slice(1).join('/')
  return keyDate ? keyDate.replace(/_/g, '-') : ''
}

// Labels and small helpers of the structural-variation view: coordinate and
// allele formatting, feature metadata rows, genome display names and payloads, and
// the remembered loading mode.
import { API_BASE } from '../../backendRuntime.js'
import { getGenomeKey } from '../../utils/genomeIdentity.js'
import { getSvGenomeDisplayName, speciesGenomeKey } from '../../utils/svCatalog.js'
import { DEFAULT_SV_LOADING_MODE, SV_LOADING_MODE_STORAGE_KEY, SV_TRANSIENT_RETRY_BASE_MS } from './svConstants.js'

// ── Helpers ───────────────────────────────────────────────────────────────────
export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

export function getSvTransientRetryDelay(attempt) {
  return Math.min(4000, SV_TRANSIENT_RETRY_BASE_MS * (2 ** Math.max(0, attempt - 1)))
}

export function formatCoord(value) {
  return Number(value || 0).toLocaleString()
}

export function formatBp(span) {
  const n = Number(span || 0)
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)} Mb`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} kb`
  return `${Math.round(n)} bp`
}

export function isLikelySequenceMetadataValue(value) {
  const text = String(value || '').trim()
  if (text.length < 28 || /\s/.test(text)) return false
  const sequenceChars = text.match(/[ACGTURYKMSWBDHVN.-]/gi)?.length || 0
  return sequenceChars / Math.max(1, text.length) >= 0.88
}

export function abbreviateMetadataValue(value) {
  const text = String(value || '').trim()
  if (!text) return { display: '', full: '', abbreviated: false }
  const shouldAbbreviate = isLikelySequenceMetadataValue(text) || (text.length > 96 && !/\s/.test(text))
  if (!shouldAbbreviate) return { display: text, full: text, abbreviated: false }
  const edgeLength = text.length > 80 ? 8 : 5
  return {
    display: `${text.slice(0, edgeLength)}...${text.slice(-edgeLength)}`,
    full: text,
    abbreviated: true,
  }
}

export function formatSvFeatureLocation(chrom, start, end) {
  const safeChrom = String(chrom || '').trim()
  const s = Number(start)
  const e = Number(end)
  if (!safeChrom || !Number.isFinite(s) || !Number.isFinite(e)) return ''
  const displayStart = Math.max(1, Math.floor(s) + 1)
  const displayEnd = Math.max(displayStart, Math.floor(e))
  return displayStart === displayEnd
    ? `${safeChrom}:${formatCoord(displayStart)}`
    : `${safeChrom}:${formatCoord(displayStart)}-${formatCoord(displayEnd)}`
}

export function formatSvStrand(value) {
  const text = String(value || '').trim()
  if (text === '+') return '+ (forward)'
  if (text === '-') return '- (reverse)'
  if (/^(forward|reverse)$/i.test(text)) return text.toLowerCase()
  return 'Unknown'
}

export function formatSvVariantType(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  return text
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase())
}

export function formatSvBoolean(value) {
  const text = String(value || '').trim()
  if (/^(true|yes|1)$/i.test(text)) return 'Yes'
  if (/^(false|no|0)$/i.test(text)) return 'No'
  return text
}

export function getSvChangedAlleleSegment(refAllele, altAllele, variantType) {
  const ref = String(refAllele || '')
  const alt = String(altAllele || '')
  const type = String(variantType || '').trim().toLowerCase()
  if (!ref || !alt) return { label: '', value: '' }

  let prefix = 0
  while (
    prefix < ref.length &&
    prefix < alt.length &&
    ref[prefix].toUpperCase() === alt[prefix].toUpperCase()
  ) {
    prefix += 1
  }

  let suffix = 0
  while (
    suffix < ref.length - prefix &&
    suffix < alt.length - prefix &&
    ref[ref.length - 1 - suffix].toUpperCase() === alt[alt.length - 1 - suffix].toUpperCase()
  ) {
    suffix += 1
  }

  const refChanged = ref.slice(prefix, ref.length - suffix)
  const altChanged = alt.slice(prefix, alt.length - suffix)
  if (type.includes('deletion') && refChanged) {
    return { label: 'Deleted sequence', value: refChanged.toUpperCase() }
  }
  if (type.includes('insertion') && altChanged) {
    return { label: 'Inserted sequence', value: altChanged.toUpperCase() }
  }
  return { label: '', value: '' }
}

export function formatSvAlleleValue(value) {
  return String(value || '').trim().toUpperCase()
}

export function getSvFeatureExtraMap(feature) {
  return feature?.extra_fields_map && typeof feature.extra_fields_map === 'object'
    ? feature.extra_fields_map
    : {}
}

export function getSvFeatureExtraValue(extraMap, name) {
  const wanted = String(name || '').trim().toLowerCase()
  for (const [key, value] of Object.entries(extraMap || {})) {
    if (String(key || '').trim().toLowerCase() === wanted) {
      return String(value ?? '').trim()
    }
  }
  return ''
}

export function isGenericBigBedFieldName(name) {
  return /^field\d+$/i.test(String(name || '').trim()) || /^extra[_\s-]?\d+$/i.test(String(name || '').trim())
}

export function formatBigBedFieldLabel(name) {
  const text = String(name || '').trim()
  if (!text || isGenericBigBedFieldName(text)) return ''
  return text
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (match) => match.toUpperCase())
}

export function buildCuratedSvIntervalRows(feature, context = {}) {
  const f = feature || {}
  const extrasMap = getSvFeatureExtraMap(f)
  const field5 = getSvFeatureExtraValue(extrasMap, 'field5')
  const field6 = getSvFeatureExtraValue(extrasMap, 'field6')
  const field7 = getSvFeatureExtraValue(extrasMap, 'field7')
  const field8 = getSvFeatureExtraValue(extrasMap, 'field8')
  const field10 = getSvFeatureExtraValue(extrasMap, 'field10')
  const field11 = getSvFeatureExtraValue(extrasMap, 'field11')
  const field12 = getSvFeatureExtraValue(extrasMap, 'field12')
  const looksLikeSvInterval = Boolean(field5 || field6 || field7 || field8 || field10 || field11)

  const location = formatSvFeatureLocation(context.chrom || f.chrom, f.start, f.end)
  const rows = [
    ['Track', context.trackLabel || ''],
    ['Side', context.side || ''],
    ['Location', location],
    ['Strand', formatSvStrand(f.strand)],
  ]

  if (f.has_name && String(f.name || '').trim()) {
    rows.push(['Name', String(f.name).trim()])
  }
  if (f.has_score && String(f.score ?? '').trim()) {
    rows.push(['Score', String(f.score).trim()])
  }

  if (looksLikeSvInterval) {
    const changedAllele = getSvChangedAlleleSegment(field7, field8, field6)
    rows.push(
      ['Variant key', field5],
      ['Variant type', formatSvVariantType(field6)],
      ['Reference allele', formatSvAlleleValue(field7)],
      ['Alternate allele', formatSvAlleleValue(field8)],
      [changedAllele.label, changedAllele.value],
      ['Consequence', formatSvVariantType(field10)],
      ['Length', field11],
      ['Present', formatSvBoolean(field12)],
    )
  } else {
    for (const [name, value] of Object.entries(extrasMap)) {
      const label = formatBigBedFieldLabel(name)
      const text = String(value ?? '').trim()
      if (label && text) rows.push([label, text])
    }
  }

  return rows.filter(([, value]) => String(value ?? '').trim())
}

export function buildSvRuntimeEndpoint(path, alignmentId = '', outputDir = '') {
  const params = new URLSearchParams()
  if (alignmentId) params.set('alignment_id', alignmentId)
  if (outputDir) params.set('output_dir', outputDir)
  const query = params.toString()
  return query ? `${API_BASE}${path}?${query}` : `${API_BASE}${path}`
}

export function sameArrayItems(left, right) {
  if (left === right) return true
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
  return left.every((item, index) => item === right[index])
}

export function updateObjectSlot(prev, key, value) {
  const current = prev?.[key]
  if (current === value || sameArrayItems(current, value)) return prev
  return { ...prev, [key]: value }
}

export function composeSvGenomeLabel(name, assembly) {
  const safeName = String(name || '').trim() || 'Genome'
  const safeAssembly = String(assembly || '').trim()
  if (!safeAssembly || normalizeAssemblyLabel(safeAssembly) === normalizeAssemblyLabel(safeName)) return safeName
  return `${safeName} - ${safeAssembly}`
}

export function getSpeciesDisplayName(species) {
  const name = String(
    species?.display_name
    || species?.common_name
    || species?.scientific_name
    || species?.name
    || 'Genome',
  ).trim()
  const assembly = species?.assembly_name || species?.assembly || species?.gca || species?.accession || ''
  return composeSvGenomeLabel(name, assembly)
}

export function getSvCatalogGenomeDisplayName(genome) {
  const name = String(
    genome?.display_name
    || genome?.common_name
    || genome?.scientific_name
    || genome?.name
    || getSvGenomeDisplayName(genome),
  ).trim()
  const assembly = genome?.assembly_name || genome?.assembly || genome?.gca || genome?.accession || ''
  return composeSvGenomeLabel(name, assembly)
}

export function getSvGenomeAccessionLabel(genomeOrSpecies) {
  return String(
    genomeOrSpecies?.gca
    || genomeOrSpecies?.accession
    || genomeOrSpecies?.assembly
    || '',
  ).trim()
}

export function getSvOptionTooltip(option) {
  if (!option) return ''
  const genome = option.species || option.genome || {}
  const label = option.label || getSpeciesDisplayName(option.species) || getSvCatalogGenomeDisplayName(option.genome)
  const accession = getSvGenomeAccessionLabel(genome)
  const aliases = Array.isArray(option.genome?.aliases) ? option.genome.aliases : []
  return [label, accession, ...aliases.slice(0, 4)].filter(Boolean).join(' | ')
}

export function getSvRuntimeAssembly(species) {
  return species?.assembly_name || species?.assembly || species?.gca || species?.accession || species?.key || ''
}

export function buildSvGenomePayload(species, fallbackGenome = null) {
  const fallback = fallbackGenome || {}
  return {
    provider: species?.provider || fallback.provider || '',
    species_key: species?.species_key || fallback.species_key || '',
    assembly: species?.assembly || species?.gca || species?.accession || fallback.assembly || fallback.gca || fallback.accession || '',
    gca: species?.gca || fallback.gca || '',
    accession: species?.accession || species?.assembly || species?.gca || fallback.accession || fallback.assembly || fallback.gca || '',
    assembly_name: species?.assembly_name || fallback.assembly_name || fallback.display_name || '',
    scientific_name: species?.scientific_name || fallback.scientific_name || '',
    common_name: species?.common_name || fallback.common_name || '',
    display_name: species?.display_name || fallback.display_name || getSpeciesDisplayName(species) || getSvGenomeDisplayName(fallback),
    genome_key: speciesGenomeKey(species) || fallback.genome_key || fallback.id || '',
    aliases: [
      speciesGenomeKey(species),
      species?.assembly,
      species?.gca,
      species?.accession,
      species?.assembly_name,
      species?.display_name,
      ...(species?.equivalent_accessions || []),
      ...(fallback.aliases || []),
    ].filter(Boolean),
  }
}

export function normalizeAssemblyLabel(value) {
  return (value || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}

export function getSvLoadingMode() {
  if (typeof window === 'undefined') return DEFAULT_SV_LOADING_MODE
  const raw = String(window.localStorage?.getItem(SV_LOADING_MODE_STORAGE_KEY) || '').trim().toLowerCase()
  return raw === 'windowed' ? 'windowed' : DEFAULT_SV_LOADING_MODE
}

export function dedupeSvSpeciesList(speciesList) {
  const out = []
  const seen = new Set()
  for (const species of speciesList || []) {
    const key = speciesGenomeKey(species)
    if (!species || !key || seen.has(key)) continue
    seen.add(key)
    out.push(species)
  }
  return out
}

export function svSpeciesSelectionKey(species) {
  return getGenomeKey(species) || speciesGenomeKey(species)
}

// The key and label conventions this view uses, handed to the shared option
// builder so it does not have to guess at either.
export const svGenomeOptionNaming = {
  keyForSpecies: svSpeciesSelectionKey,
  labelForSpecies: getSpeciesDisplayName,
  labelForGenome: getSvCatalogGenomeDisplayName,
}

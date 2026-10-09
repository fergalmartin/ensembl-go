// The Stats view's model: biotype classes and colours, structural metrics, number
// formatting, genome inputs and placeholder records, axis ticks. Pure functions.
import { getGenomeKey, normalizeGenomeProvider, normalizeGenomeRecord, normalizeGenomeSourceDatabase } from '../../utils/genomeIdentity.js'

export const MAJOR_CLASS_ORDER = ['coding', 'lnoncoding', 'snoncoding', 'pseudogene']

export const MAJOR_CLASS_COLORS = {
  coding: '#2563eb',
  lnoncoding: '#0891b2',
  snoncoding: '#7c3aed',
  pseudogene: '#ea580c',
}

export const MAJOR_CLASS_LABELS = {
  coding: 'coding',
  lnoncoding: 'long non-coding',
  snoncoding: 'small non-coding',
  pseudogene: 'pseudogene',
}

export const STRUCTURAL_METRICS = [
  { key: 'avg_exon_count', label: 'Avg exon count', format: 'float' },
  { key: 'median_exon_count', label: 'Median exon count', format: 'float' },
  { key: 'avg_exon_size', label: 'Avg exon size', format: 'float' },
  { key: 'median_exon_size', label: 'Median exon size', format: 'float' },
  { key: 'avg_intron_size', label: 'Avg intron size', format: 'float' },
  { key: 'median_intron_size', label: 'Median intron size', format: 'float' },
  { key: 'avg_cds_length', label: 'Avg CDS length', format: 'float' },
  { key: 'median_cds_length', label: 'Median CDS length', format: 'float' },
  { key: 'avg_cds_exon_count', label: 'Avg CDS exons', format: 'float' },
  { key: 'avg_utr5_length', label: "Avg 5' UTR length", format: 'float' },
  { key: 'avg_utr3_length', label: "Avg 3' UTR length", format: 'float' },
  { key: 'regular_cds_fraction', countKey: 'regular_cds_count', label: 'Regular CDS', format: 'percent', sequenceBased: true },
  { key: 'small_intron_gap_fraction', countKey: 'small_intron_gap_count', label: 'Small introns/gaps', format: 'percent' },
  { key: 'non_canonical_splice_fraction', countKey: 'non_canonical_splice_count', label: 'Non-canonical splicing', format: 'percent', sequenceBased: true },
]

export const STRUCTURAL_PLOT_METRICS = [
  ...STRUCTURAL_METRICS.filter((metric) => metric.format !== 'int'),
]

export const STRUCTURAL_PLOT_COLOR_SCALE = [
  '#1f77b4',
  '#ff7f0e',
  '#2ca02c',
  '#d62728',
  '#9467bd',
  '#8c564b',
  '#e377c2',
  '#17becf',
  '#bcbd22',
  '#393b79',
  '#637939',
  '#8c6d31',
]

export const SUMMARY_CORE_SECTIONS = ['annotation', 'structural', 'homology']

export const STRUCTURAL_SELECTABLE_STATUSES = new Set(['missing', 'stale', 'error'])

export const STRUCTURAL_PENDING_STATUSES = new Set(['missing', 'stale', 'error', 'computing'])

export function toNumber(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

export function rectsOverlap(a, b) {
  if (!a || !b) return false
  return (
    a.x < (b.x + b.width)
    && (a.x + a.width) > b.x
    && a.y < (b.y + b.height)
    && (a.y + a.height) > b.y
  )
}

export function formatInt(value) {
  if (value === null || value === undefined) return '—'
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  return Math.round(n).toLocaleString()
}

export function formatFloat(value, digits = 2) {
  if (value === null || value === undefined) return '—'
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  return n.toFixed(digits)
}

export function formatPercent(value) {
  if (value === null || value === undefined) return '—'
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  return `${(n * 100).toFixed(1)}%`
}

export function structuralMetricValue(record, key) {
  const structural = record?.structural || {}
  if (Object.prototype.hasOwnProperty.call(structural, key)) {
    return structural[key]
  }
  // Backward-compatible fallback for old cached key.
  if (key === 'regular_cds_fraction' && Object.prototype.hasOwnProperty.call(structural, 'valid_cds_fraction')) {
    return structural.valid_cds_fraction
  }
  return (structural.metrics || {})[key]
}

export function truncateText(value, maxLen = 22) {
  const text = String(value || '')
  if (text.length <= maxLen) return text
  if (maxLen < 4) return text.slice(0, maxLen)
  return `${text.slice(0, maxLen - 3)}...`
}

export function structuralDisplayStatus(status) {
  if (status === 'loading') return 'Loading…'
  if (status === 'computing') return 'Generating'
  if (status === 'ready') return 'Ready'
  return 'Select to generate'
}

export function normalizeGenomeInput(raw) {
  const normalized = normalizeGenomeRecord(raw)
  const files = normalized?.files || {}
  return {
    selection_key: normalized?.selection_key || '',
    assembly_key: normalized?.assembly_key || '',
    species_key: normalized?.species_key || '',
    assembly: normalized?.assembly || '',
    assembly_name: normalized?.assembly_name || normalized?.assembly || '',
    scientific_name: normalized?.scientific_name || '',
    common_name: normalized?.common_name || '',
    provider: normalizeGenomeProvider(normalized),
    source_database: normalizeGenomeSourceDatabase(normalized),
    gca: normalized?.gca || normalized?.assembly || '',
    dataset_release_key: normalized?.dataset_release_key || '',
    dataset_release_source: normalized?.dataset_release_source || '',
    dataset_release_date: normalized?.dataset_release_date || '',
    dataset_release_label: normalized?.dataset_release_label || '',
    dataset_release_short_label: normalized?.dataset_release_short_label || '',
    files: {
      gff3: files?.gff3 || '',
      index: files?.index || '',
      fasta: files?.fasta || '',
      homology: files?.homology || '',
      metadata: files?.metadata || '',
    },
  }
}

export function genomeKeyFromInput(raw) {
  return getGenomeKey(raw)
}

export function buildPlaceholderRecord(genome) {
  const genomeKey = genomeKeyFromInput(genome)
  return {
    genome_key: genomeKey,
    species_key: genome?.species_key || '',
    assembly: genome?.assembly || '',
    assembly_name: genome?.assembly_name || genome?.assembly || '',
    scientific_name: genome?.scientific_name || '',
    common_name: genome?.common_name || '',
    provider: genome?.provider || '',
    source_database: genome?.source_database || '',
    gca: genome?.gca || '',
    files: genome?.files || {},
    // Waiting on this genome's summary, which is a different thing from its
    // structural stats being generated ('computing').
    statuses: {
      annotation: 'loading',
      structural: 'loading',
      homology: 'loading',
      assembly: 'loading',
    },
    annotation: null,
    structural: null,
    homology: null,
    assembly_info: null,
  }
}

export function buildErrorRecord(genome, message) {
  const record = buildPlaceholderRecord(genome)
  record.statuses = {
    annotation: 'error',
    structural: 'error',
    homology: 'error',
    assembly: 'error',
  }
  record.error = String(message || 'Failed to load stats for genome.')
  return record
}

export function makeTicks(minValue, maxValue, count = 5) {
  const min = Number(minValue)
  const max = Number(maxValue)
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [min]
  const out = []
  for (let i = 0; i < count; i += 1) {
    const f = i / (count - 1)
    out.push(min + ((max - min) * f))
  }
  return out
}

export function genomeLabel(record) {
  const common = (record?.common_name || '').trim()
  const sci = (record?.scientific_name || '').trim()
  const asm = (record?.assembly_name || record?.assembly || '').trim()
  const base = common || sci || record?.species_key || 'Genome'
  return asm ? `${base} - ${asm}` : base
}

export function classifyBiotypeClass(rawBiotype, mappedClass = '') {
  const mapped = String(mappedClass || '').trim().toLowerCase()
  if (MAJOR_CLASS_ORDER.includes(mapped)) return mapped
  const biotype = String(rawBiotype || '').trim().toLowerCase()
  if (biotype === 'protein_coding' || biotype.startsWith('protein_coding')) return 'coding'
  if (biotype.includes('pseudogene')) return 'pseudogene'
  if (biotype.startsWith('ig_') || biotype.startsWith('tr_')) return 'coding'
  if (
    biotype.startsWith('mirna')
    || biotype.startsWith('snorna')
    || biotype.startsWith('snrna')
    || biotype.startsWith('rrna')
    || biotype.startsWith('trna')
    || biotype.startsWith('misc_rna')
    || biotype.startsWith('ribozyme')
    || biotype.startsWith('scarna')
    || biotype.startsWith('pirna')
    || biotype.startsWith('sirna')
    || biotype.startsWith('mt_trna')
    || biotype.startsWith('mt_rrna')
  ) return 'snoncoding'
  if (
    biotype.startsWith('lnc')
    || biotype.startsWith('ncrna')
    || biotype.includes('rna')
    || biotype.endsWith('_gene')
  ) return 'lnoncoding'
  return 'lnoncoding'
}

export function majorClassCountsForAnnotation(annotation, basis) {
  const out = {}
  for (const cls of MAJOR_CLASS_ORDER) out[cls] = 0

  const ann = annotation || {}
  const biotypeCounts = basis === 'genes'
    ? (ann.gene_biotype_counts || {})
    : (ann.transcript_biotype_counts || {})
  const biotypeMajorClassMap = basis === 'genes'
    ? (ann.gene_biotype_major_class_map || {})
    : (ann.transcript_biotype_major_class_map || {})

  let usedBiotypeCounts = false
  for (const [biotypeName, rawValue] of Object.entries(biotypeCounts || {})) {
    const value = toNumber(rawValue, 0)
    if (value <= 0) continue
    usedBiotypeCounts = true
    const mapped = biotypeMajorClassMap[biotypeName] || biotypeMajorClassMap[String(biotypeName || '').toLowerCase()] || ''
    const cls = classifyBiotypeClass(biotypeName, mapped)
    out[cls] = toNumber(out[cls], 0) + value
  }
  if (usedBiotypeCounts) return out

  const majorCounts = basis === 'genes'
    ? (ann.major_class_gene_counts || {})
    : (ann.major_class_transcript_counts || {})
  const aliasToMajorClass = {
    coding: 'coding',
    protein_coding: 'coding',
    immune_receptor: 'coding',
    lnoncoding: 'lnoncoding',
    noncoding: 'lnoncoding',
    non_coding: 'lnoncoding',
    snoncoding: 'snoncoding',
    mnoncoding: 'snoncoding',
    pseudogene: 'pseudogene',
    other: 'lnoncoding',
  }
  for (const [rawKey, rawValue] of Object.entries(majorCounts || {})) {
    const key = String(rawKey || '').trim().toLowerCase()
    const mapped = aliasToMajorClass[key]
    if (!mapped) continue
    out[mapped] = toNumber(out[mapped], 0) + toNumber(rawValue, 0)
  }
  return out
}

export function biotypeSubtypePriority(name) {
  const key = String(name || '').trim().toLowerCase()
  if (key === 'lncrna' || key === 'lnc_rna' || key.includes('lncrna') || key.includes('lnc_rna') || key.includes('long_noncoding_rna')) {
    return -1
  }
  return 0
}

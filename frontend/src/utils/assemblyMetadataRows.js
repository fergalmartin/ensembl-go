// What the registry knows about an assembly, as an ordered list of label/value
// pairs.
//
// Two surfaces show this: the stats overview draws it as a grid of tiles, and
// the genome browser's assembly drawer draws it as a two-column list. Both read
// the same rows from here so neither can quietly gain or lose a field.
//
// Deliberately free of React and of the fetch that produces `assemblyInfo`, so
// it can be unit-tested on its own.

import { normalizeGenomeSourceDatabase } from './genomeIdentity.js'

export const formatMetadataInt = (value) => {
  const number = Number(value)
  return Number.isFinite(number) ? number.toLocaleString() : '—'
}

export const formatMetadataBases = (value) => {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return '—'
  if (number >= 1e9) return `${(number / 1e9).toFixed(2)} Gb`
  if (number >= 1e6) return `${(number / 1e6).toFixed(2)} Mb`
  if (number >= 1e3) return `${(number / 1e3).toFixed(1)} kb`
  return `${number} bp`
}

export const formatMetadataDate = (value) => {
  const text = String(value || '').trim()
  if (!text) return ''
  const parsed = Date.parse(text)
  return Number.isNaN(parsed) ? text : new Date(parsed).toLocaleDateString()
}

/** True once there is anything worth drawing for this assembly. */
export function hasAssemblyMetadata(assemblyInfo) {
  const ena = assemblyInfo?.ena || {}
  const fasta = assemblyInfo?.fasta || {}
  return ena.status === 'ready' || Object.keys(fasta).length > 0
}

/**
 * The rows for one genome.
 *
 * `assemblyInfo` is a stats record's `assembly_info` — `{ ena: { data }, fasta }`.
 * `genome` is the species record it belongs to, which carries the fallbacks used
 * when the registry has nothing to say about a field.
 *
 * Rows with no value at all are dropped; a field the formatters render as an
 * em dash is kept, because "we looked and there is no number" is itself worth
 * saying.
 */
export function buildAssemblyMetadataRows({ genome = null, assemblyInfo = null } = {}) {
  const record = assemblyInfo?.ena?.data || {}
  const fasta = assemblyInfo?.fasta || {}
  const assemblyName = String(genome?.assembly_name || genome?.assembly || '').trim()
  const accession = String(genome?.assembly || genome?.gca || '').trim()

  const entries = [
    ['Assembly', record.assembly_name || assemblyName],
    ['Accession', record.accession || accession],
    ['Level', record.assembly_level || ''],
    ['Provider', normalizeGenomeSourceDatabase(genome)],
    ['Species', record.scientific_name || String(genome?.scientific_name || '').trim()],
    ['Taxonomy ID', record.tax_id || ''],
    ['Submitter', record.submitter || ''],
    ['Last updated', formatMetadataDate(record.last_updated)],
    ['Sequences', formatMetadataInt(fasta.contig_count ?? record.contig_count)],
    ['Chromosomes', record.chromosome_count ? formatMetadataInt(record.chromosome_count) : ''],
    ['Total bases', formatMetadataBases(fasta.total_bases ?? record.sequence_length)],
    ['Longest', formatMetadataBases(fasta.longest_sequence)],
    ['N50', formatMetadataBases(fasta.n50)],
    ['L50', fasta.l50 ? formatMetadataInt(fasta.l50) : ''],
  ]

  return entries
    .filter(([, value]) => value !== '' && value !== null && value !== undefined)
    .map(([label, value]) => ({ label, value: String(value) }))
}

/**
 * The note the stats view prints when the registry answered about a different
 * accession than the one on disk. Empty when there is nothing to explain.
 */
export function equivalentAccessionNote(assemblyInfo, accession) {
  const found = String(assemblyInfo?.ena?.accession || '').trim()
  const asked = String(accession || '').trim()
  if (!found || found === asked) return ''
  return `Registry metadata read from the equivalent assembly ${found}.`
}

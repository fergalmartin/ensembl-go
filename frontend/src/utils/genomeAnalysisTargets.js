// Works out what there is to analyse for a set of active genomes.
//
// Every genome has one assembly (a FASTA) and one or more gene sets — a genome
// downloaded twice from Ensembl has a dataset release per year, and a genome can
// carry an imported annotation alongside the one it shipped with. Each of those
// is analysed on its own, so each needs its own identity, its own stored report
// and its own place in the tree.
//
// This is deliberately free of React: the same description drives the stats
// overview today and can drive any other view that wants to show, or offer, the
// analysis of a genome.

import {
  buildDatasetSelectionKey,
  formatDatasetBadgeLabel,
  formatDatasetReleaseShortLabel,
  getAssemblyGenomeKey,
  getGenomeKey,
  normalizeGenomeSourceDatabase,
} from './genomeIdentity.js'
import { getCurrentGenomeAnalysis } from './genomeAnalysis.js'

export const ASSEMBLY_SECTION_TYPE = 'fasta'
export const GENE_SET_SECTION_TYPE = 'gff3'
export const METADATA_SECTION_TYPE = 'metadata'

export function assemblySectionId(genomeKey) {
  return `${genomeKey}::${ASSEMBLY_SECTION_TYPE}`
}

export function metadataSectionId(genomeKey) {
  return `${genomeKey}::${METADATA_SECTION_TYPE}`
}

export function geneSetSectionId(genomeKey, releaseKey) {
  return `${genomeKey}::${GENE_SET_SECTION_TYPE}::${releaseKey || 'default'}`
}

/**
 * The key a gene set's report is stored under.
 *
 * The genome's own dataset reuses the genome key verbatim, which is what the
 * genome selector writes — so an analysis run there is found here, and vice
 * versa. Other releases get the selection key that identifies them.
 */
export function analysisKeyForRelease(genome, releaseKey) {
  const genomeKey = getGenomeKey(genome)
  const ownRelease = String(genome?.dataset_release_key || '').trim()
  const key = String(releaseKey || '').trim()
  if (!key || key === ownRelease) return genomeKey
  return buildDatasetSelectionKey(getAssemblyGenomeKey(genome), key) || genomeKey
}

function releasesFor(genome) {
  const releases = Array.isArray(genome?.dataset_releases) ? genome.dataset_releases : []
  const withAnnotation = releases.filter((release) => String(release?.files?.gff3 || '').trim())
  if (withAnnotation.length > 0) return withAnnotation
  // A manually registered genome has no release list, just the one annotation.
  const gff3 = String(genome?.files?.gff3 || '').trim()
  if (!gff3) return []
  return [{
    key: String(genome?.dataset_release_key || '').trim(),
    label: String(genome?.dataset_release_label || '').trim(),
    short_label: String(genome?.dataset_release_short_label || '').trim(),
    files: { gff3 },
  }]
}

function releaseLabelFor(genome, release) {
  // Same rule as the dataset badge on a genome pill: an Ensembl release is
  // named by its date, everyone else by their provider, because "current" —
  // which is all RefSeq ever reports — tells the reader nothing.
  return formatDatasetBadgeLabel({
    provider: genome?.provider,
    is_manual: genome?.is_manual,
    source_database: genome?.source_database,
    assembly: genome?.assembly || genome?.gca,
    dataset_release_key: release?.key,
    dataset_release_source: release?.source,
    dataset_release_date: release?.date,
    dataset_release_label: release?.label,
    dataset_release_short_label: release?.short_label,
  })
    || formatDatasetReleaseShortLabel(release)
    || String(genome?.dataset_release_short_label || '').trim()
    || 'Gene set'
}

/** Distinguish gene sets that would otherwise carry the same name. */
function withDistinctLabels(geneSets) {
  const counts = new Map()
  for (const geneSet of geneSets) {
    counts.set(geneSet.label, (counts.get(geneSet.label) || 0) + 1)
  }
  return geneSets.map((geneSet) => {
    if ((counts.get(geneSet.label) || 0) < 2) return geneSet
    const suffix = formatDatasetReleaseShortLabel({ key: geneSet.releaseKey }) || geneSet.releaseKey
    return suffix ? { ...geneSet, label: `${geneSet.label} ${suffix}` } : geneSet
  })
}

/**
 * Describe the analysable parts of each genome.
 *
 * `analysisReports` is the config's `genome_analysis_reports`; any report it
 * holds for the exact files in play is attached, which is what makes an
 * analysis run in one view show up already done in another.
 */
export function buildGenomeAnalysisTargets(genomes, {
  analysisReports = {},
  activeGenomeKeys = null,
  fileOverrides = {},
} = {}) {
  const list = Array.isArray(genomes) ? genomes : []
  // The genomes switched on in the current view, in the order they were
  // activated — which is also the order their colours are assigned in. A caller
  // that does not track activation treats every genome it passed as active.
  const activeOrder = Array.isArray(activeGenomeKeys)
    ? activeGenomeKeys.map((key) => String(key || '').trim()).filter(Boolean)
    : null

  return list.map((genome, index) => {
    const genomeKey = getGenomeKey(genome)
    const overrides = fileOverrides?.[genomeKey] || {}
    const files = { ...(genome?.files || {}), ...overrides }
    const fastaPath = String(files.fasta || '').trim()
    const defaultReleaseKey = String(
      genome?.default_dataset_release_key || genome?.dataset_release_key || '',
    ).trim()
    const activeIndex = activeOrder ? activeOrder.indexOf(genomeKey) : index
    const isActive = activeIndex >= 0

    const releases = releasesFor(genome)
    const geneSets = releases.map((release) => {
      const releaseKey = String(release?.key || '').trim()
      const isDefault = releases.length === 1
        || (!!defaultReleaseKey && releaseKey === defaultReleaseKey)
      // The genome's own files carry any override the user has set; other
      // releases are read straight from the release they belong to.
      const gff3 = isDefault && String(files.gff3 || '').trim()
        ? String(files.gff3).trim()
        : String(release?.files?.gff3 || '').trim()
      const sectionFiles = { gff3, fasta: fastaPath }
      const analysisKey = analysisKeyForRelease(genome, releaseKey)
      return {
        id: geneSetSectionId(genomeKey, releaseKey),
        type: GENE_SET_SECTION_TYPE,
        kind: 'annotation',
        releaseKey,
        label: releaseLabelFor(genome, release),
        isDefault,
        path: gff3,
        files: sectionFiles,
        analysisKey,
        analysis: getCurrentGenomeAnalysis(analysisReports, analysisKey, GENE_SET_SECTION_TYPE, sectionFiles),
      }
    }).filter((geneSet) => geneSet.path)
    const distinctGeneSets = withDistinctLabels(geneSets)

    const assemblyFiles = { fasta: fastaPath }
    return {
      genome,
      genomeKey,
      assemblyKey: getAssemblyGenomeKey(genome),
      displayName: String(genome?.display_name || genome?.common_name || genome?.scientific_name || genomeKey).trim(),
      scientificName: String(genome?.scientific_name || '').trim(),
      assemblyName: String(genome?.assembly_name || genome?.assembly || '').trim(),
      assembly: String(genome?.assembly || genome?.gca || '').trim(),
      providerName: normalizeGenomeSourceDatabase(genome),
      isActive,
      //: Position among the active genomes, which is the index the genome
      //: colours in the configuration view are assigned by. -1 when inactive.
      colorIndex: activeIndex,
      // Not an analysis: this is what the registry says about the assembly,
      // read from the report downloaded with it. It leads because it is the
      // cheapest useful thing to know about a genome.
      metadata_section: {
        id: metadataSectionId(genomeKey),
        type: METADATA_SECTION_TYPE,
        label: 'Assembly metadata',
      },
      assembly_section: {
        id: assemblySectionId(genomeKey),
        type: ASSEMBLY_SECTION_TYPE,
        kind: 'genome',
        label: 'Genome assembly',
        path: fastaPath,
        files: assemblyFiles,
        analysisKey: genomeKey,
        analysis: getCurrentGenomeAnalysis(analysisReports, genomeKey, ASSEMBLY_SECTION_TYPE, assemblyFiles),
      },
      geneSets: distinctGeneSets,
    }
  })
}

/**
 * The sections revealed when a genome is opened.
 *
 * Only its metadata: that is a cache read that says something useful about
 * every genome. The analyses below it are long reports, and opening those
 * unasked buries the list they belong to.
 */
export function sectionIdsForOpenGenome(target) {
  if (!target) return []
  return [target.metadata_section.id]
}

/**
 * What starts open: the genomes switched on in this view, each showing its
 * assembly metadata. Genomes still in the list but deactivated stay shut — the
 * reader can open any of them, they just do not open themselves.
 */
export function defaultExpandedAnalysisSections(targets) {
  const open = new Set()
  for (const target of targets || []) {
    if (!target.isActive) continue
    open.add(target.genomeKey)
    for (const id of sectionIdsForOpenGenome(target)) open.add(id)
  }
  return open
}

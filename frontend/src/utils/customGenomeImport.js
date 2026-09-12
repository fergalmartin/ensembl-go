// Registering a genome from files already on disk.
//
// This lives outside the Genome Selector because two callers need it and only one of them
// is a view. The form in `GenomeSelectorView` is the way a person does it; the tutorial
// runtime is the other, and it has to be able to do it from a step in a *different app* —
// views unmount when they are not active, so a step in the genome browser that expects the
// genome to exist cannot reach anything inside the selector to make it so.
//
// Nothing here touches React state. Give it paths and labels, get back a genome record.

import { API_BASE } from '../backendRuntime'
import { normalizeGenomeRecord } from './genomeIdentity'
import { canonicalBundleFiles } from './genomeFileTypes'

export const basenameFromPath = (value = '') => {
  const normalized = String(value || '').replace(/\\/g, '/')
  const trimmed = normalized.endsWith('/') ? normalized.slice(0, -1) : normalized
  if (!trimmed) return ''
  const parts = trimmed.split('/')
  return parts[parts.length - 1] || ''
}

export const dirnameFromPath = (value = '') => {
  const normalized = String(value || '').replace(/\\/g, '/')
  const trimmed = normalized.endsWith('/') ? normalized.slice(0, -1) : normalized
  const idx = trimmed.lastIndexOf('/')
  if (idx < 0) return '.'
  if (idx === 0) return '/'
  return trimmed.slice(0, idx)
}

export const joinPath = (base, child) => {
  if (!base) return child
  if (!child) return base
  if (base === '/') return `/${child}`
  return `${base.replace(/\/+$/, '')}/${child}`
}

// Strips any annotation extension, so a GTF does not derive an index named
// `<name>.gtf.gz.gff3.index.db`.
export const stripGffSuffix = (filename = '') =>
  filename.replace(/\.(?:ensembl\.)?(?:gff3|gff|gtf|gff2)(\.(?:gz|bgz))?$/i, '')

export const deriveIndexPathFromGff = (gffPath = '', fallbackDir = '') => {
  if (!gffPath) return ''
  const file = basenameFromPath(gffPath)
  const prefix = stripGffSuffix(file) || 'genome'
  const dir = dirnameFromPath(gffPath) || fallbackDir || '.'
  return joinPath(dir, `${prefix}.gff3.index.db`)
}

/** The species key a genome label becomes. */
export const toSpeciesKey = (value = '') =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')

/** Convert an annotation into something the indexer can read, and wait for it.
 *
 *  A GTF cannot be indexed at all, and a GFF3 the indexer already handles is passed
 *  through untouched — `conversion_required()` on the backend decides. Either way the
 *  result is the path that should actually be indexed. */
export async function prepareAnnotation(annotationPath, fastaPath, onProgress = null) {
  const res = await fetch(`${API_BASE}/api/custom/prepare-annotation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ annotation_path: annotationPath, fasta_path: fastaPath || null }),
  })
  const started = await res.json()
  if (!res.ok) throw new Error(started?.detail || 'Failed to prepare the annotation')

  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 300))
    const poll = await fetch(`${API_BASE}/api/custom/conversion/${started.task_id}`)
    const payload = await poll.json()
    if (!poll.ok) throw new Error(payload?.detail || 'Preparation lookup failed')
    onProgress?.({
      status: payload.status,
      progress: Number(payload.progress || 0),
      stage: payload.stage || '',
      message: payload.message || '',
      counters: payload.counters || {},
    })
    if (payload.status === 'failed') throw new Error(payload.error || 'Failed to prepare the annotation')
    if (payload.status === 'success') return payload.report || {}
  }
}

/** Build the genome record a set of files and labels amounts to.
 *
 *  Pure. The identity it produces is what everything else keys off, and it is derived from
 *  what the user typed: the species key from the genome label, the assembly from the
 *  accession if there is one and the assembly label otherwise. */
export function buildManualGenomeRecord(entry, annotationPath = '', prepared = null) {
  const speciesLabel = String(entry?.species || '').trim()
  const assemblyLabel = String(entry?.assembly || '').trim()
  const assemblyName = String(entry?.assembly_name || '').trim() || assemblyLabel
  const accession = String(entry?.accession || '').trim()
  const provider = String(entry?.provider || '').trim() || 'manual'
  const isHandAdded = provider.toLowerCase() === 'manual'
  const files = canonicalBundleFiles(entry?.files)
  const preparedAnnotation = annotationPath || files.gff3 || ''
  const artifacts = prepared?.converted
    ? {
      converted_annotation: String(prepared.annotation_path || preparedAnnotation || ''),
      source_annotation: String(prepared.source_path || files.gff3 || ''),
      id_map: String(prepared.id_map_path || ''),
      generated_at: new Date().toISOString(),
    }
    : (entry?.artifacts && typeof entry.artifacts === 'object' ? entry.artifacts : null)

  const resolvedFiles = { ...files }
  if (preparedAnnotation) {
    resolvedFiles.gff3 = preparedAnnotation
    if (!resolvedFiles.index) resolvedFiles.index = deriveIndexPathFromGff(preparedAnnotation)
  } else {
    delete resolvedFiles.gff3
    delete resolvedFiles.index
  }
  const release = entry?.dataset_release || {}

  return normalizeGenomeRecord({
    species_key: String(entry?.species_key || '').trim() || toSpeciesKey(speciesLabel) || 'manual_species',
    // Accession first, as before: it is what the genome key is built from, so changing the
    // precedence would rekey existing genomes.
    assembly: accession || assemblyLabel,
    assembly_name: assemblyName,
    scientific_name: speciesLabel,
    common_name: String(entry?.common_name || '').trim(),
    display_name: String(entry?.display_name || '').trim(),
    display_name_reason: String(entry?.display_name_reason || '').trim(),
    provider,
    source_database: String(entry?.source_database || '').trim() || (isHandAdded ? 'Manual' : provider),
    gca: accession,
    equivalent_accessions: Array.isArray(entry?.equivalent_accessions) ? entry.equivalent_accessions : [],
    dataset_release_key: String(release.key || '').trim(),
    dataset_release_source: String(release.source || '').trim(),
    dataset_release_date: String(release.date || '').trim(),
    dataset_release_label: String(release.label || '').trim(),
    dataset_release_short_label: String(release.short_label || '').trim(),
    // Registered from local files rather than managed by the downloader.
    is_manual: true,
    types: Object.keys(resolvedFiles).filter((type) => resolvedFiles[type]),
    has_annotation: Boolean(preparedAnnotation),
    files: resolvedFiles,
    missing_files: Array.isArray(entry?.missing_files) ? entry.missing_files : [],
    ...(artifacts ? { artifacts } : {}),
  })
}

/** Prepare the annotation and build the record, in one go. */
export async function importLocalGenome({ species, assembly, accession = '', files = {} }) {
  let annotationPath = files.gff3 || ''
  let prepared = null
  if (annotationPath) {
    prepared = await prepareAnnotation(annotationPath, files.fasta || '')
    annotationPath = prepared.annotation_path || annotationPath
  }
  return buildManualGenomeRecord({ species, assembly, accession, files }, annotationPath, prepared)
}

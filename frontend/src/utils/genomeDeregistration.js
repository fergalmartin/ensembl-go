/**
 * Removing genomes from the configuration.
 *
 * A genome key is written into more places than any one caller remembers: the
 * active selection, the manual registrations, the analysis reports, the file
 * overrides, every playlist's member list, the previous-session snapshot, and
 * the ref/target pointers. Removing a genome from only some of them is what
 * makes a deleted genome come back after a restart, so this is the single place
 * that knows the full list.
 *
 * Pure and free of React so it can be tested directly.
 */

import { genomeKeyCandidates, genomeKeysMatch } from './genomeIdentity.js'
import { withoutGenomeAnalysis } from './genomeAnalysis.js'

const ANALYSIS_FILE_TYPES = ['fasta', 'gff3']

/** Every key form the genomes to remove might be stored under. */
export function removalKeyCandidates(genomes) {
  const keys = []
  for (const genome of Array.isArray(genomes) ? genomes : []) {
    const candidates = typeof genome === 'string' ? [genome] : genomeKeyCandidates(genome)
    for (const candidate of candidates) {
      const key = String(candidate || '').trim()
      if (key && !keys.includes(key)) keys.push(key)
    }
  }
  return keys
}

function matchesAny(entry, genomes) {
  return genomes.some((genome) => genomeKeysMatch(entry, genome))
}

function filterList(list, genomes) {
  const source = Array.isArray(list) ? list : []
  const kept = source.filter((entry) => !matchesAny(entry, genomes))
  return kept.length === source.length ? null : kept
}

/**
 * Remove `genomes` from every part of `config` that refers to them.
 *
 * Returns the next config plus the keys that were removed, which the caller
 * hands to App as `__removed_genome_keys` so it can prune its own selection
 * state. Downloaded genomes are filesystem-discovered, so an explicit
 * deregistration is also persisted as a hidden key even when the genome was
 * already inactive.
 */
export function deregisterGenomesFromConfig(config, genomes) {
  const source = config && typeof config === 'object' ? config : {}
  const targets = (Array.isArray(genomes) ? genomes : []).filter(Boolean)
  if (targets.length === 0) {
    return { config: source, removedKeys: [], changed: false }
  }

  const updates = {}
  let changed = false

  for (const field of ['active_species', 'manual_species', 'next_previous_session_genomes']) {
    const next = filterList(source[field], targets)
    if (next) {
      updates[field] = next
      changed = true
    }
  }

  // Analyses and overrides are keyed by genome key, and a genome may have been
  // stored under an older key form, so clear every candidate.
  const keys = removalKeyCandidates(targets)

  // Downloaded genomes are discovered from their files on every selector
  // refresh. Remember an explicit deregistration so discovery does not
  // immediately recreate the row while those files remain on disk.
  const deregistered = Array.isArray(source.deregistered_genome_keys)
    ? source.deregistered_genome_keys.map((key) => String(key || '').trim()).filter(Boolean)
    : []
  const nextDeregistered = [...deregistered]
  for (const key of keys) {
    if (!nextDeregistered.some((existing) => genomeKeysMatch(existing, key))) {
      nextDeregistered.push(key)
    }
  }
  if (nextDeregistered.length !== deregistered.length) {
    updates.deregistered_genome_keys = nextDeregistered
    changed = true
  }

  let analyses = source.genome_analysis_reports || {}
  const analysesBefore = analyses
  for (const key of keys) {
    for (const fileType of ANALYSIS_FILE_TYPES) {
      analyses = withoutGenomeAnalysis(analyses, key, fileType)
    }
  }
  if (analyses !== analysesBefore) {
    updates.genome_analysis_reports = analyses
    changed = true
  }

  const overrides = source.genome_file_overrides
  if (overrides && typeof overrides === 'object') {
    const nextOverrides = { ...overrides }
    let overridesChanged = false
    for (const key of Object.keys(overrides)) {
      if (keys.includes(key) || matchesAny(key, targets)) {
        delete nextOverrides[key]
        overridesChanged = true
      }
    }
    if (overridesChanged) {
      updates.genome_file_overrides = nextOverrides
      changed = true
    }
  }

  // Playlists lose the genome but are never themselves deleted: an emptied
  // playlist is still the user's, and the backend restores the previous list
  // when an empty one arrives without an explicit clear.
  const playlists = Array.isArray(source.genome_playlists) ? source.genome_playlists : []
  if (playlists.length > 0) {
    let playlistsChanged = false
    const nextPlaylists = playlists.map((playlist) => {
      const members = filterList(playlist?.genomes, targets)
      if (!members) return playlist
      playlistsChanged = true
      return { ...playlist, genomes: members }
    })
    if (playlistsChanged) {
      updates.genome_playlists = nextPlaylists
      changed = true
    }
  }

  // Ref/target point at the genome currently being browsed. Clear them when the
  // genome that owned them is going, or when nothing is left to browse; App
  // re-derives the pointers from whatever survives.
  const survivingActive = updates.active_species || source.active_species || []
  const removedAnnotations = new Set()
  for (const genome of targets) {
    for (const value of [genome?.files?.gff3, genome?.files?.fasta]) {
      const path = String(value || '').trim()
      if (path) removedAnnotations.add(path)
    }
  }
  const ownedByRemoved = (path) => {
    const value = String(path || '').trim()
    if (!value) return false
    return removedAnnotations.has(value) || survivingActive.length === 0
  }
  if (source.ref_gff || source.ref_fasta) {
    if (ownedByRemoved(source.ref_gff) || ownedByRemoved(source.ref_fasta)) {
      Object.assign(updates, { ref_fasta: '', ref_gff: '', ref_index: '', homologies_file: '' })
      changed = true
    }
  }
  if (source.target_gff || source.target_fasta) {
    if (ownedByRemoved(source.target_gff) || ownedByRemoved(source.target_fasta)) {
      Object.assign(updates, { target_fasta: '', target_gff: '', target_index: '' })
      changed = true
    }
  }

  if (!changed) {
    return { config: source, removedKeys: [], changed: false }
  }

  return {
    config: { ...source, ...updates, __removed_genome_keys: keys },
    removedKeys: keys,
    changed: true,
  }
}

export default deregisterGenomesFromConfig

// The automatic 'previous session' genome playlists: snapshotting the active
// genomes and keeping the playlist entries up to date. Pure functions.
import { genomeKeysMatch, normalizeGenomeRecord } from '../utils/genomeIdentity.js'
import { NEXT_PREVIOUS_SESSION_PLAYLIST_ID, PREVIOUS_SESSION_PLAYLIST_ID } from './appLayout.js'
import { dedupeSpeciesList, speciesItemKey } from './genomeLists.js'

export function snapshotGenomeForPreviousSession(species) {
  const normalized = normalizeGenomeRecord(species)
  const key = speciesItemKey(normalized)
  if (!key) return null
  const files = normalized?.files && typeof normalized.files === 'object'
    ? {
        fasta: String(normalized.files.fasta || '').trim(),
        gff3: String(normalized.files.gff3 || '').trim(),
        index: String(normalized.files.index || '').trim(),
        homology: String(normalized.files.homology || '').trim(),
        metadata: String(normalized.files.metadata || '').trim(),
      }
    : undefined
  return {
    key,
    assembly_key: String(normalized?.assembly_key || '').trim(),
    selection_key: String(normalized?.selection_key || key).trim(),
    species_key: String(normalized?.species_key || '').trim(),
    assembly: String(normalized?.assembly || normalized?.gca || '').trim(),
    scientific_name: String(normalized?.scientific_name || '').trim(),
    common_name: String(normalized?.common_name || '').trim(),
    display_name: String(normalized?.display_name || '').trim(),
    display_name_reason: String(normalized?.display_name_reason || '').trim(),
    assembly_name: String(normalized?.assembly_name || normalized?.assembly || normalized?.gca || '').trim(),
    provider: String(normalized?.provider || '').trim(),
    source_database: String(normalized?.source_database || '').trim(),
    gca: String(normalized?.gca || '').trim(),
    dataset_release_key: String(normalized?.dataset_release_key || '').trim(),
    dataset_release_source: String(normalized?.dataset_release_source || '').trim(),
    dataset_release_date: String(normalized?.dataset_release_date || '').trim(),
    dataset_release_label: String(normalized?.dataset_release_label || '').trim(),
    dataset_release_short_label: String(normalized?.dataset_release_short_label || '').trim(),
    is_manual: Boolean(normalized?.is_manual),
    ...(files ? { files } : {}),
    active_by_default: true,
  }
}

export function buildPreviousSessionGenomes(speciesList) {
  const genomes = []
  for (const species of dedupeSpeciesList(speciesList)) {
    const snapshot = snapshotGenomeForPreviousSession(species)
    if (!snapshot || genomes.some((genome) => genomeKeysMatch(genome, snapshot))) continue
    genomes.push(snapshot)
  }
  return genomes
}

export function isPreviousSessionPlaylist(playlist) {
  return playlist?.id === PREVIOUS_SESSION_PLAYLIST_ID ||
    String(playlist?.name || '').trim().toLowerCase() === 'previous session'
}

export function isNextPreviousSessionPlaylist(playlist) {
  return playlist?.id === NEXT_PREVIOUS_SESSION_PLAYLIST_ID
}

export function findPreviousSessionPlaylist(playlists) {
  return (Array.isArray(playlists) ? playlists : []).find(isPreviousSessionPlaylist) || null
}

export function findNextPreviousSessionPlaylist(playlists) {
  return (Array.isArray(playlists) ? playlists : []).find(isNextPreviousSessionPlaylist) || null
}

export function upsertPreviousSessionPlaylist(configObj, speciesList, { select = false } = {}) {
  if (!configObj) return configObj
  const playlists = Array.isArray(configObj.genome_playlists) ? configObj.genome_playlists : []
  const existing = findPreviousSessionPlaylist(playlists)
  const { system, ...existingFields } = existing || {}
  const previousPlaylist = {
    ...existingFields,
    id: PREVIOUS_SESSION_PLAYLIST_ID,
    name: 'Previous session',
    description: String(existing?.description || 'Active genomes from the last app session.').trim(),
    genomes: buildPreviousSessionGenomes(speciesList),
  }
  const otherPlaylists = playlists.filter((playlist) => !isPreviousSessionPlaylist(playlist))
  return {
    ...configObj,
    genome_playlists: [previousPlaylist, ...otherPlaylists],
    ...(select ? { selected_genome_playlist_id: PREVIOUS_SESSION_PLAYLIST_ID } : {}),
  }
}

export function updatePreviousSessionPlaylist(configObj, speciesList, options = {}) {
  if (!configObj) return configObj
  const previousGenomes = buildPreviousSessionGenomes(speciesList)
  if (previousGenomes.length === 0 && !findPreviousSessionPlaylist(configObj.genome_playlists)) {
    return configObj
  }
  return upsertPreviousSessionPlaylist(configObj, previousGenomes, options)
}

export function withNextPreviousSessionGenomes(configObj, speciesList) {
  if (!configObj) return configObj
  const playlists = Array.isArray(configObj.genome_playlists) ? configObj.genome_playlists : []
  const nextPlaylist = {
    id: NEXT_PREVIOUS_SESSION_PLAYLIST_ID,
    name: 'Next previous session',
    description: 'Hidden tracker for the next Previous session playlist.',
    genomes: buildPreviousSessionGenomes(speciesList),
    hidden: true,
  }
  return {
    ...configObj,
    genome_playlists: [nextPlaylist, ...playlists.filter((playlist) => !isNextPreviousSessionPlaylist(playlist))],
    next_previous_session_genomes: buildPreviousSessionGenomes(speciesList),
  }
}

export function removeEmptyPreviousSessionPlaylist(configObj) {
  if (!configObj) return configObj
  const playlists = Array.isArray(configObj.genome_playlists) ? configObj.genome_playlists : []
  return {
    ...configObj,
    genome_playlists: playlists.filter((playlist) => !isPreviousSessionPlaylist(playlist)),
    selected_genome_playlist_id: configObj.selected_genome_playlist_id === PREVIOUS_SESSION_PLAYLIST_ID
      ? '__all__'
      : configObj.selected_genome_playlist_id,
  }
}

// How a genome is written into a playlist, and how a playlist is named in a tutorial.
//
// Shared because a playlist built by the user through the Genome Selector and one a
// tutorial step establishes on arrival have to hold the same thing. They did not, once:
// two snapshot shapes meant the playlist the tutorial created and the playlist the user
// created applied differently, which is the same class of bug as the two genome records
// that disagreed about a genome's identity.

import {
  getGenomeKey,
  normalizeGenomeProvider,
  normalizeGenomeRecord,
  normalizeGenomeSourceDatabase,
} from './genomeIdentity'

export const titleCaseWords = (value = '') =>
  value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')

export const formatSpeciesNameFromKey = (speciesKey = '') => (
  titleCaseWords(String(speciesKey || '').replace(/_/g, ' '))
)

export const buildPlaylistId = () => (
  `playlist_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
)

/** A playlist's stable name in a tutorial document, and in the DOM.
 *
 * Playlist ids are minted at random when a playlist is created, so a tutorial step cannot
 * name one: the playlist it is about does not exist until the user creates it, three steps
 * earlier, under a name the tutorial itself dictated. The name is the part the tutorial
 * controls, so the name — slugged — is what the target anchors are keyed on. */
export const playlistTourSlug = (name = '') => (
  String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
)

export const snapshotGenomeForPlaylist = (item) => {
  const normalized = normalizeGenomeRecord(item)
  const key = getGenomeKey(normalized)
  if (!key) return null
  return {
    key,
    assembly_key: String(normalized?.assembly_key || '').trim(),
    selection_key: String(normalized?.selection_key || key).trim(),
    species_key: String(normalized?.species_key || '').trim(),
    assembly: String(normalized?.assembly || '').trim(),
    scientific_name: String(normalized?.scientific_name || '').trim() || formatSpeciesNameFromKey(normalized?.species_key || ''),
    common_name: String(normalized?.common_name || '').trim(),
    display_name: String(normalized?.display_name || '').trim(),
    display_name_reason: String(normalized?.display_name_reason || '').trim(),
    assembly_name: String(normalized?.assembly_name || normalized?.assembly || '').trim(),
    provider: normalizeGenomeProvider(normalized),
    source_database: normalizeGenomeSourceDatabase(normalized),
    gca: String(normalized?.gca || '').trim(),
    dataset_release_key: String(normalized?.dataset_release_key || '').trim(),
    dataset_release_source: String(normalized?.dataset_release_source || '').trim(),
    dataset_release_date: String(normalized?.dataset_release_date || '').trim(),
    dataset_release_label: String(normalized?.dataset_release_label || '').trim(),
    dataset_release_short_label: String(normalized?.dataset_release_short_label || '').trim(),
    is_manual: Boolean(normalized?.is_manual),
    active_by_default: Boolean(item?.active_by_default),
  }
}

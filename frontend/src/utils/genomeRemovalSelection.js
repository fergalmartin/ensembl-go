/**
 * Two selections coexist in the genome selector, and they must never be
 * confused: the Active ticks say which genomes the app is working with, and the
 * removal flags say which ones are about to be deleted. This module holds the
 * set arithmetic for both, free of React so it can be tested directly.
 */

import { getGenomeKey } from './genomeIdentity.js'

export const REMOVAL_FILL_ALL = 'all'
export const REMOVAL_FILL_SELECTED = 'selected'
export const REMOVAL_FILL_NONE = 'none'

const MANUAL_GENERATED_FILE_TYPES = new Set([
  'index',
  'gff3_index',
  'gtf_index',
  'cdna_index',
  'protein_index',
])

const MANUAL_GENERATED_ARTIFACT_TYPES = new Set([
  'converted_annotation',
  'id_map',
])

/** Rows that can be acted on at all — a playlist entry with no local files cannot. */
export function selectableItems(items) {
  return (Array.isArray(items) ? items : []).filter((item) => item && !item.is_missing)
}

/**
 * Whether the binary header checkbox should be filled. It stays filled while
 * any selectable row shown by the current filter is selected; clicking it in
 * that state clears every shown row.
 */
export function computeSelectAllChecked(filteredItems, selectedKeys) {
  const candidates = selectableItems(filteredItems)
  if (candidates.length === 0) return false
  const keys = selectedKeys instanceof Set ? selectedKeys : new Set(selectedKeys || [])
  for (const item of candidates) {
    if (keys.has(getGenomeKey(item))) return true
  }
  return false
}

/**
 * Next flag set for a quick-fill action.
 *
 * `all` covers everything the filter shows, `selected` mirrors the genomes that
 * are currently active, `none` clears. Flags for rows outside the current filter
 * are kept: narrowing a search must not silently unflag what is off screen.
 */
export function nextRemovalFlags(current, action, { filteredItems = [], selectedKeys = new Set() } = {}) {
  const flags = new Set(current || [])
  const candidates = selectableItems(filteredItems)
  const keys = selectedKeys instanceof Set ? selectedKeys : new Set(selectedKeys || [])

  if (action === REMOVAL_FILL_NONE) return new Set()
  if (action === REMOVAL_FILL_ALL) {
    for (const item of candidates) flags.add(getGenomeKey(item))
    return flags
  }
  if (action === REMOVAL_FILL_SELECTED) {
    for (const item of candidates) {
      if (keys.has(getGenomeKey(item))) flags.add(getGenomeKey(item))
    }
    return flags
  }
  return flags
}

/** Flip one row's flag. */
export function toggleRemovalFlag(current, item) {
  const flags = new Set(current || [])
  if (!item || item.is_missing) return flags
  const key = getGenomeKey(item)
  if (!key) return flags
  if (flags.has(key)) flags.delete(key)
  else flags.add(key)
  return flags
}

/**
 * Split the flagged genomes by what removing them can actually do:
 *   downloaded — files under local_data that the app can delete
 *   manual     — registered from the user's own files; only generated artifacts go
 *   missing    — nothing on disk here, so deregistering is all that is possible
 */
export function partitionRemovalTargets(items) {
  const downloaded = []
  const manual = []
  const missing = []
  for (const item of Array.isArray(items) ? items : []) {
    if (!item) continue
    if (item.is_missing) missing.push(item)
    else if (item.is_manual) manual.push(item)
    else downloaded.push(item)
  }
  return { downloaded, manual, missing }
}

/** Genomes matching the flag set, in the order the table shows them. */
export function flaggedItems(items, flags) {
  const keys = flags instanceof Set ? flags : new Set(flags || [])
  return (Array.isArray(items) ? items : []).filter((item) => keys.has(getGenomeKey(item)))
}

/**
 * File paths already present on registered genome records. This gives the
 * summary useful content immediately while the backend checks generated
 * sidecars and filesystem safety rules.
 *
 * Download-managed files are all candidates. For manually registered genomes,
 * only app-generated index/artifact fields are candidates; the user's FASTA
 * and annotation must never be presented as files we intend to delete.
 */
export function registeredRemovalFiles(items) {
  const entries = []
  const seen = new Set()
  const add = (path, kind = 'registered') => {
    const value = String(path || '').trim()
    if (!value || seen.has(value)) return
    seen.add(value)
    entries.push({ path: value, kind, bytes: 0 })
  }

  for (const item of Array.isArray(items) ? items : []) {
    if (!item) continue
    const records = [
      item,
      ...(Array.isArray(item.dataset_instances) ? item.dataset_instances : []),
    ]
    for (const record of records) {
      const files = record?.files && typeof record.files === 'object' ? record.files : {}
      for (const [fileType, path] of Object.entries(files)) {
        if (!item.is_manual || MANUAL_GENERATED_FILE_TYPES.has(fileType)) {
          add(path, fileType)
        }
      }
      if (item.is_manual) {
        const artifacts = record?.artifacts && typeof record.artifacts === 'object' ? record.artifacts : {}
        for (const [artifactType, path] of Object.entries(artifacts)) {
          if (MANUAL_GENERATED_ARTIFACT_TYPES.has(artifactType)) add(path, artifactType)
        }
      }
    }
  }
  return entries
}

/** "1.2 GB" — deliberately vague, since sizes on disk are an upper bound. */
export function formatBytes(bytes) {
  const value = Number(bytes) || 0
  if (value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)))
  const scaled = value / (1024 ** exponent)
  return `${scaled >= 10 || exponent === 0 ? Math.round(scaled) : scaled.toFixed(1)} ${units[exponent]}`
}

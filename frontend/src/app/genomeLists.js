// Lists of genomes in the app shell: labels, identity keys, de-duplication,
// ordering and per-view capacity. Pure functions.
import { getGenomeKey } from '../utils/genomeIdentity.js'

export function formatSpeciesForLabel(species) {
  if (!species) return ''
  if (species.display_name) return species.display_name
  if (species.common_name) return species.common_name
  const sci = species.scientific_name || ''
  if (!sci) return ''
  const parts = sci.trim().split(/\s+/)
  if (parts.length < 2) return sci
  return `${parts[0][0]}. ${parts.slice(1).join(' ')}`
}

export function buildGenomeLabel(tag, species, fallback) {
  const name = formatSpeciesForLabel(species) || fallback
  const assembly = species?.assembly_name || species?.assembly || ''
  return assembly ? `${tag} ${name} - ${assembly}` : `${tag} ${name}`
}

export function buildGenomePillLabel(species) {
  if (!species) return ''
  const name = formatSpeciesForLabel(species) || species.scientific_name || ''
  const assembly = species?.assembly_name || species?.assembly || ''
  return assembly ? `${name} - ${assembly}` : name
}

export function speciesItemKey(species) {
  return getGenomeKey(species)
}

export function basenameFromPath(value = '') {
  const normalized = String(value || '').replace(/\\/g, '/')
  return normalized.split('/').filter(Boolean).pop() || ''
}

export function dirnameFromPath(value = '') {
  const normalized = String(value || '').replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  if (index <= 0) return index === 0 ? '/' : ''
  return normalized.slice(0, index)
}

export function speciesListsEqualByKey(a, b) {
  if (a === b) return true
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (speciesItemKey(a[i]) !== speciesItemKey(b[i])) return false
  }
  return true
}

export function sameStringArrayItems(a, b) {
  if (a === b) return true
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  return a.every((item, index) => item === b[index])
}

export function dedupeSpeciesList(speciesList) {
  const out = []
  const seen = new Set()
  for (const species of Array.isArray(speciesList) ? speciesList : []) {
    if (!species) continue
    const key = speciesItemKey(species)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(species)
  }
  return out
}

export function prependUniqueSpecies(speciesList, species) {
  if (!species) return dedupeSpeciesList(speciesList)
  const key = speciesItemKey(species)
  const filtered = dedupeSpeciesList(speciesList).filter((item) => speciesItemKey(item) !== key)
  return [species, ...filtered]
}

export function appendUniqueSpecies(speciesList, species) {
  if (!species) return dedupeSpeciesList(speciesList)
  const key = speciesItemKey(species)
  const filtered = dedupeSpeciesList(speciesList).filter((item) => speciesItemKey(item) !== key)
  return [...filtered, species]
}

export function getViewActiveCapacity(viewId) {
  if (viewId === 'homology') return Number.POSITIVE_INFINITY
  if (viewId === 'genome_browser') return Number.POSITIVE_INFINITY
  if (viewId === 'alignment') return Number.POSITIVE_INFINITY
  if (viewId === 'stats') return Number.POSITIVE_INFINITY
  if (viewId === 'feature_explorer') return Number.POSITIVE_INFINITY
  if (viewId === 'neighbourhood') return Number.POSITIVE_INFINITY
  if (viewId === 'structural_variation') return 3
  // The sequence view reads one genome at a time and has a control of its own
  // for choosing which. That control offers the *active* genomes, so a capacity
  // of one emptied the very list it exists to fill: a reader could not bring a
  // second genome up to switch to it, and pressing a half-lit pill put that
  // genome away instead of promoting it. Drawing one at a time is the view's
  // business; how many are available to draw is not.
  if (viewId === 'sequence') return Number.POSITIVE_INFINITY
  return 0
}

export function reorderWithInsertPosition(order, sourceId, targetId, insertPosition = 'before') {
  const sourceIndex = order.indexOf(sourceId)
  const targetIndex = order.indexOf(targetId)
  if (sourceIndex < 0 || targetIndex < 0) return order
  if (sourceId === targetId) return order

  const next = [...order]
  const [moved] = next.splice(sourceIndex, 1)
  const adjustedTargetIndex = next.indexOf(targetId)
  if (adjustedTargetIndex < 0) return order
  const insertIndex = insertPosition === 'after' ? adjustedTargetIndex + 1 : adjustedTargetIndex
  next.splice(insertIndex, 0, moved)
  return next
}

// Adapt the shared Find model to the Explorer's stored pattern format.
// utils/findPatterns.js owns patterns, priority and persistence semantics.
// Keep motif identifiers, storage keys and routes for workspace compatibility.
// Convert the Explorer's stored color field to the shared model's colour field
// at this boundary.

import {
    MAX_PATTERNS,
    activePatterns,
    loadPatterns,
    movePattern,
    normalisePatterns,
    patternSearchKey,
    resolvePatternSpans,
    savePatterns,
} from '../../utils/findPatterns.js'

export const MOTIF_STORAGE_KEY = 'alignment-explorer:motifs:v1'
export const MAX_MOTIFS = MAX_PATTERNS

/** The shared shape, spelt the way this view and its stored lists spell it. */
function toExplorer(patterns) {
  return patterns.map(({ colour, ...rest }) => ({ ...rest, color: colour }))
}

/** The shared shape, for the find box, which is the sequence view's own. */
export function loadFindPatterns(storage) {
  return loadPatterns(MOTIF_STORAGE_KEY, storage)
}
/** What a search hands the painter and the server: this view's spelling. */
export function explorerMotifs(patterns) {
  return toExplorer(patterns)
}

// What is in the find box and how it is read, kept between visits the way the
// sequence view keeps its own: the reader comes back to the box they left.
export const FIND_QUERY_KEY = 'alignment-explorer:find:v1'
export function loadFindQuery(storage) {
  try {
    const held = JSON.parse((storage ?? globalThis.localStorage)?.getItem(FIND_QUERY_KEY) || '{}')
    return { query: String(held?.query || '').slice(0, 500), kind: held?.kind === 'regex' ? 'regex' : 'literal' }
  } catch {
    return { query: '', kind: 'literal' }
  }
}
export function saveFindQuery(query, kind, storage) {
  try { (storage ?? globalThis.localStorage)?.setItem(FIND_QUERY_KEY, JSON.stringify({ query, kind })) } catch {
    // A private window refuses, and a find box is not worth failing over.
  }
}

export function normalizeMotifs(value) {
  return toExplorer(normalisePatterns(value))
}
export function loadMotifs(storage) {
  return toExplorer(loadPatterns(MOTIF_STORAGE_KEY, storage))
}
export function saveMotifs(motifs, storage) {
  return savePatterns(MOTIF_STORAGE_KEY, motifs, storage)
}
export function moveMotif(motifs, id, target) {
  return movePattern(motifs, id, target)
}
export function motifSearchKey(motifs) {
  return patternSearchKey(motifs)
}

export function motifLegend(motifs) {
  return {
    kind: 'swatches',
    swatches: activePatterns(motifs).map((m, i) => ({ label: `${i + 1}. ${m.pattern}`, colour: m.color })),
    note: 'When matches overlap, the first pattern in the list determines the colour. Unmatched sequence uses a neutral colour.',
  }
}

/** Resolve overlaps once per response/order change, never per canvas cell. */
export function resolveMotifSpans(motifs, spans) {
  // The shared resolver reads `colour`; this view's objects carry `color`.
  return resolvePatternSpans(motifs.map(m => ({ ...m, colour: m.color })), spans)
}

export { firstMotifSpan } from '../motifs/render.js'

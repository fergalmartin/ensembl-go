// The explorer's find patterns: the shared model, wearing this view's key.
//
// What a reader is looking for is not an idea about alignments, so the model --
// the ordered list, the colours, the priority resolution, what a stored list is
// worth after an upgrade -- lives in `utils/findPatterns.js` and the sequence
// view uses the same one. Two copies would have drifted about what a regex
// means, which is the one thing a reader may not be told two different answers
// to by two views of the same genome.
//
// **The word is Find now.** It was *motif*, which named what a biologist looks
// for rather than what the control does, and left the sequence view with
// nothing to call the same thing. The identifiers here still say motif -- the
// colour scheme's id, the storage key, the `/motif-jobs` routes on the backend
// -- because those are written into stored workspaces and running servers, and
// renaming them would cost a migration to change a word nobody sees.
//
// `color` rather than `colour` on the way in and out, for the same reason: it
// is what is in every reader's browser already. The shared model reads both and
// writes the British one, so this converts at the edge.

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

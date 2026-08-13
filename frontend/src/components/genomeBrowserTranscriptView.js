// Resolves which transcripts of a gene are drawn, in which order, and which of
// them is a hover-only "ghost" preview.
//
// The browser draws one transcript per row, so this list *is* the row layout:
// row packing, canvas drawing, hit-testing and footer geometry all derive from
// it. Keeping the decision here (pure, no React) means those consumers stay in
// agreement by construction.

function toIdString(value) {
  return String(value ?? '').trim()
}

function toIdSet(value) {
  if (value instanceof Set) return value
  const set = new Set()
  for (const entry of (Array.isArray(value) ? value : [])) {
    const id = toIdString(entry)
    if (id) set.add(id)
  }
  return set
}

function cleanTranscripts(transcripts) {
  return Array.isArray(transcripts) ? transcripts.filter(Boolean) : []
}

function safeLimit(limit, fallback = 1) {
  const parsed = Math.floor(Number(limit))
  return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback
}

/**
 * Default ordering: canonical transcripts first, then the rest, each group
 * keeping its incoming order. A user-supplied `order` of transcript ids wins —
 * those come first in the order given, and anything the list doesn't mention
 * follows in default order. Ids in `order` that no longer exist are ignored,
 * so a stale ordering degrades gracefully rather than dropping transcripts.
 */
export function orderTranscripts(transcripts, order) {
  const txs = cleanTranscripts(transcripts)
  if (txs.length === 0) return []

  const canonicals = txs.filter((tx) => tx?.is_canonical)
  const others = txs.filter((tx) => !tx?.is_canonical)
  const defaultOrder = [...canonicals, ...others]

  const requested = Array.isArray(order) ? order : []
  if (requested.length === 0) return defaultOrder

  const byId = new Map()
  for (const tx of defaultOrder) {
    const id = toIdString(tx?.id)
    if (id && !byId.has(id)) byId.set(id, tx)
  }

  const ordered = []
  const placed = new Set()
  for (const entry of requested) {
    const id = toIdString(entry)
    if (!id || placed.has(id)) continue
    const tx = byId.get(id)
    if (!tx) continue
    ordered.push(tx)
    placed.add(id)
  }
  for (const tx of defaultOrder) {
    const id = toIdString(tx?.id)
    if (id && placed.has(id)) continue
    ordered.push(tx)
  }
  return ordered
}

/**
 * @param {object} params
 * @param {Array} params.transcripts  all transcripts for the gene
 * @param {number} params.limit       how many rows the current zoom/expand state allows
 * @param {Array<string>} [params.order]   explicit user ordering of transcript ids
 * @param {Array<string>|Set<string>} [params.hidden]  transcript ids the user has hidden
 * @param {string} [params.ghostId]   hidden transcript to preview in the slot it would occupy
 * @returns {{rows: Array<{transcript: object, ghost: boolean}>, transcripts: Array<object>,
 *            visibleCount: number, totalCount: number, hiddenCount: number}}
 */
export function resolveGeneTranscriptView({
  transcripts,
  limit,
  order,
  hidden,
  ghostId,
} = {}) {
  const txs = cleanTranscripts(transcripts)
  const totalCount = txs.length
  if (totalCount === 0) {
    return { rows: [], transcripts: [], visibleCount: 0, totalCount: 0, hiddenCount: 0 }
  }

  const hiddenSet = toIdSet(hidden)
  const ordered = orderTranscripts(txs, order)
  const resolvedLimit = safeLimit(limit, 1)

  const shown = ordered
    .filter((tx) => !hiddenSet.has(toIdString(tx?.id)))
    .slice(0, resolvedLimit)

  const ghost = toIdString(ghostId)
  const shownIds = new Set(shown.map((tx) => toIdString(tx?.id)))
  const wantsGhost = Boolean(ghost) && !shownIds.has(ghost) && ordered.some(
    (tx) => toIdString(tx?.id) === ghost
  )

  // The ghost sits where the transcript would land if it were unhidden: keep it
  // in the filter, then take one extra row so nothing that is genuinely visible
  // gets pushed out of view by the preview.
  const rowSource = wantsGhost
    ? ordered
      .filter((tx) => {
        const id = toIdString(tx?.id)
        return !hiddenSet.has(id) || id === ghost
      })
      .slice(0, resolvedLimit + 1)
    : shown

  const rows = rowSource.map((transcript) => ({
    transcript,
    ghost: wantsGhost && toIdString(transcript?.id) === ghost,
  }))

  // With everything hidden the gene would otherwise vanish into a bare block.
  // Keep the first transcript as an outline instead, so the gene still reads as
  // a transcript structure and there is something to aim at to bring it back.
  if (rows.length === 0) {
    rows.push({ transcript: ordered[0], ghost: true })
  }

  let hiddenCount = 0
  for (const tx of ordered) {
    if (hiddenSet.has(toIdString(tx?.id))) hiddenCount += 1
  }

  return {
    rows,
    transcripts: rows.filter((row) => !row.ghost).map((row) => row.transcript),
    visibleCount: rows.filter((row) => !row.ghost).length,
    totalCount,
    hiddenCount,
  }
}

/**
 * Moves `movingId` so that it ends up at `targetIndex` in the result, returning
 * a new array. `targetIndex` is the desired *final* index, which spares callers
 * the usual off-by-one when dragging downwards. `baseOrder` should already be
 * the full list of ids (derive it with `orderTranscripts` when the user has not
 * reordered anything yet) so the result is always a complete ordering.
 */
export function reorderTranscriptIds(baseOrder, movingId, targetIndex) {
  const ids = (Array.isArray(baseOrder) ? baseOrder : [])
    .map(toIdString)
    .filter(Boolean)
  const moving = toIdString(movingId)
  const from = ids.indexOf(moving)
  if (!moving || from === -1) return ids

  const without = ids.filter((id) => id !== moving)
  const requested = Math.floor(Number(targetIndex))
  const clamped = Number.isFinite(requested)
    ? Math.max(0, Math.min(without.length, requested))
    : without.length

  without.splice(clamped, 0, moving)
  return without
}

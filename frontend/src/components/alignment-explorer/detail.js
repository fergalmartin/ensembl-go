import { highlightedRows, rowSlot, panelRect } from './layers.js'
import { ROW_HEIGHT, MARGIN_X } from './layout.js'

/** Block context: one source block, read against an explicit comparison.
 *
 * The model here is deliberately transient. It is never written into the saved
 * workspace, because a lens onto a block is not a statement about the alignment
 * and a saved one could name a block, a row or a transcript that is no longer
 * there. Closing puts back the layer, camera, selection and row order the reader
 * came in with, and that restoration is what `origin` carries.
 *
 * Three separate ideas, which earlier drafts kept confusing with one another:
 *
 * - the **reference** is what everything is compared against,
 * - the **order** is where the rows sit,
 * - the **pair** is the two rows being inspected in detail.
 *
 * Changing any one of them leaves the other two alone. In particular, moving a
 * row never changes what it is compared against, and choosing a new reference
 * never rearranges the stack.
 */

export const COMPARISON_MODES = ['reference', 'adjacent']
/** Lanes a row group occupies: one for its sequence, the rest for its tracks. */
export const SEQUENCE_LANES = 1
export const DEFAULT_TRACK_LANES = 1
/** Genomic context around a selection, in bases. The floor is what makes a
 * single-base selection legible; the ceiling is a request bound, not taste. */
export const CONTEXT_MIN_BP = 0
export const CONTEXT_DEFAULT_BP = 2000
export const CONTEXT_MAX_BP = 100_000

/** Rows a newly opened block context should hold.
 *
 * An explicit pick narrows it; picking the block itself does not. A block pick
 * carries every row id by construction (`blockPick`), so treating it as a
 * narrowing would mean entering from a picked header always "restricted" the
 * view to everything — a restriction notice over an unrestricted sheet. A pick
 * covering every row is likewise not a narrowing, whichever way it was made.
 */
export function restrictRows(rowIds, selection, highlighted) {
  const picked = new Set(highlightedRows(highlighted))
  for (const pick of selection || []) {
    if (pick?.kind === 'block') continue
    for (const id of pick?.rowIds || []) picked.add(id)
  }
  const kept = rowIds.filter(id => picked.has(id))
  return kept.length && kept.length < rowIds.length ? kept : rowIds
}

/** The first row that actually has alignment coverage in this block.
 *
 * A reference with no bases here cannot answer "different from what", so the
 * fallback is explicit and reported rather than silent. `available` is the
 * block's own account of which rows carry sequence (MAF `e` rows carry none). */
export function chooseReference(rowIds, available) {
  if (!rowIds.length) return { reference: null, fallback: null }
  const covered = available ? rowIds.filter(id => available.includes(id)) : rowIds
  if (!covered.length) return { reference: null, fallback: 'none' }
  if (covered[0] === rowIds[0]) return { reference: rowIds[0], fallback: null }
  return { reference: covered[0], fallback: rowIds[0] }
}

export function createDetail({ fragmentId, sourceBlock, length, rowIds, allRowIds, available = null, frame = null, origin = null }) {
  const rows = [...rowIds]
  const { reference, fallback } = chooseReference(rows, available)
  return {
    fragmentId, sourceBlock, length,
    rows,
    allRows: [...(allRowIds || rowIds)],
    available: available ? [...available] : null,
    reference, referenceFallback: fallback,
    mode: 'reference',
    pair: null,
    picks: {},
    expanded: {},
    genomic: { open: false, context: CONTEXT_DEFAULT_BP, selection: null },
    frame, origin,
  }
}

export const detailRestricted = detail => (detail?.rows?.length || 0) < (detail?.allRows?.length || 0)

/** Lanes one row occupies, sequence included. Expanding a gene grows this row
 * and moves the rows under it; it never changes anyone else's lane count. */
export const rowLanes = (detail, rowId) =>
  SEQUENCE_LANES + Math.max(DEFAULT_TRACK_LANES, Number(detail?.trackLanes?.[rowId]) || 0, Number(detail?.expanded?.[rowId]) || DEFAULT_TRACK_LANES)

/** Cumulative lane placement for a list of rows.
 *
 * Slots are derived from complete row groups rather than assigned per sequence,
 * which is what makes a reorder move a row together with its own annotation
 * lanes instead of sliding sequences over someone else's tracks. */
export function rowGroups(detail, rows = detail?.rows || []) {
  let slot = 0
  return rows.map(rowId => {
    const lanes = rowLanes(detail, rowId)
    const group = { rowId, slot, lanes }
    slot += lanes
    return group
  })
}
export const totalLanes = groups => groups.reduce((n, g) => n + g.lanes, 0)

/** Rows that scroll, and the row pinned above them.
 *
 * In reference mode the reference is read against every target, so it is pinned
 * once at the top and taken out of the scrolling stack: scrolling to a target
 * whose reference has gone off the top compares it with nothing visible. In
 * adjacent mode every row is read against the one above it, so there is nothing
 * to pin and the whole stack scrolls. */
export function splitRows(detail) {
  if (!detail) return { pinned: null, targets: [] }
  if (detail.mode !== 'reference' || !detail.reference) return { pinned: null, targets: detail.rows }
  return { pinned: detail.reference, targets: detail.rows.filter(id => id !== detail.reference) }
}

/** What a row is compared against, which is the whole of what the two modes
 * disagree about. Null means "nothing to compare with": the reference itself,
 * the top row in adjacent mode, or a block with no covered row at all. */
export function comparatorFor(detail, rowId) {
  if (!detail || !rowId) return null
  if (detail.mode === 'adjacent') {
    const index = detail.rows.indexOf(rowId)
    return index > 0 ? detail.rows[index - 1] : null
  }
  return rowId === detail.reference ? null : detail.reference || null
}

/** Every distinct comparator in play, so sequence requests can be grouped by the
 * row their summaries are relative to rather than by the block alone. */
export function comparators(detail) {
  const values = new Set()
  for (const rowId of detail?.rows || []) {
    const against = comparatorFor(detail, rowId)
    if (against) values.add(against)
  }
  return [...values]
}

/** The pair being inspected, resolved against what is actually displayed.
 *
 * Held loosely rather than pinned to ids that may have been hidden or moved: a
 * stored pair whose rows are no longer both on the sheet falls back to the
 * active row and its current comparator, so adjacent mode always compares the
 * neighbours the reader can see. */
export function activePair(detail) {
  if (!detail?.rows?.length) return null
  const rows = new Set(detail.rows)
  const stored = detail.pair
  if (stored && rows.has(stored[0]) && rows.has(stored[1]) && comparatorFor(detail, stored[1]) === stored[0]) return [...stored]
  const lower = detail.rows.find(id => comparatorFor(detail, id))
  if (!lower) return null
  return [comparatorFor(detail, lower), lower]
}

export function setReference(detail, rowId) {
  if (!detail || !detail.rows.includes(rowId)) return detail
  if (detail.reference === rowId) return detail
  // The manual order is the reader's work and survives a change of reference.
  return { ...detail, reference: rowId, referenceFallback: null, pair: null }
}

export function setMode(detail, mode) {
  if (!detail || !COMPARISON_MODES.includes(mode) || detail.mode === mode) return detail
  return { ...detail, mode, pair: null }
}

/** Move a row before another, carrying its lanes with it. `before` of null
 * moves it to the end. */
export function moveRow(detail, rowId, before) {
  if (!detail || rowId === before || !detail.rows.includes(rowId)) return detail
  const rest = detail.rows.filter(id => id !== rowId)
  const at = before == null ? rest.length : rest.indexOf(before)
  if (before != null && at < 0) return detail
  return { ...detail, rows: [...rest.slice(0, at), rowId, ...rest.slice(at)], pair: null }
}

export const setLanes = (detail, rowId, lanes) =>
  ({ ...detail, expanded: { ...detail.expanded, [rowId]: Math.max(DEFAULT_TRACK_LANES, Math.round(lanes) || DEFAULT_TRACK_LANES) } })

export const pickTranscript = (detail, rowId, transcriptId) => {
  const picks = { ...detail.picks }
  if (transcriptId) picks[rowId] = transcriptId; else delete picks[rowId]
  // Picking a target's transcript says nothing about the reference, and picking
  // the reference's does not choose anyone else's: no relationship is inferred
  // from matching names, exon numbers or overlapping columns.
  return { ...detail, picks }
}

export const clampContext = bp => Math.min(CONTEXT_MAX_BP, Math.max(CONTEXT_MIN_BP, Math.round(Number(bp) || 0)))

/** The fragments the detail layer draws: the pinned reference, then the stack.
 *
 * Both carry the same `sourceBlock`, `start` and `end`, so tile planning, gap
 * memory and every column-space calculation treat them as one block seen twice
 * — which is what they are. Only their vertical placement differs. */
export function detailFragments(detail, { coverage = null } = {}) {
  if (!detail) return []
  const { pinned, targets } = splitRows(detail)
  const base = { sourceBlock: detail.sourceBlock, start: 0, end: detail.length, x: 0, detail: true }
  if (coverage) base.coverage = coverage
  const fragments = []
  const pinnedGroups = pinned ? rowGroups(detail, [pinned]) : []
  const pinnedLanes = totalLanes(pinnedGroups)
  const targetGroups = rowGroups(detail, targets)
  if (targets.length) fragments.push({
    ...base, id: 'detail:targets', rowIds: targets,
    slots: targetGroups.map(g => g.slot), layoutRows: Math.max(1, totalLanes(targetGroups)),
    y: pinnedLanes,
  })
  // Last, so it is painted over the stack scrolling beneath it.
  if (pinned) fragments.push({
    ...base, id: 'detail:reference', rowIds: [pinned],
    slots: [0], layoutRows: Math.max(1, pinnedLanes), y: 0, pinned: true,
  })
  return fragments
}

export const detailLayer = (detail, options) => ({
  id: 'detail', name: 'Block context', color: '#7fb2e8',
  fragments: detailFragments(detail, options), detail: true,
})

/** Where a row's track lanes are, in canvas pixels, given its panel rect. */
export function laneRect(fragment, rect, rowIndex, rowHeight) {
  const slot = fragment.slots?.[rowIndex] ?? rowIndex
  const lanes = (fragment.slots?.[rowIndex + 1] ?? (fragment.layoutRows ?? 0)) - slot
  return {
    x: rect.x, width: rect.width,
    y: rect.y + (slot + SEQUENCE_LANES) * rowHeight,
    height: Math.max(0, (lanes - SEQUENCE_LANES) * rowHeight),
  }
}

/** Why a lane is empty, in the reader's words. Never "no genes": an empty track
 * whose genome was never installed is not a statement about biology. */
export function emptyLaneReason(entry, row) {
  const reason = entry?.reason || row?.availability
  if (reason === 'no-coverage') return 'No aligned sequence in this block'
  if (reason === 'unplaced') return 'This row has no genomic coordinates'
  if (reason === 'unresolved') return 'No genome link for this sequence'
  if (reason === 'unavailable') return 'That assembly is not installed here'
  if (reason === 'no-annotation') return 'That genome has no annotation installed'
  if (reason === 'no-region') return 'That region is not in the installed genome'
  if (reason === 'failed') return 'Annotation could not be read'
  if (entry) return 'No annotated features over these columns'
  return 'Loading annotation…'
}

/** The transcript a row is showing: the reader's pick, else its representative. */
export function shownTranscript(entry, picked) {
  const all = (entry?.genes || []).flatMap(gene => gene.transcripts.map(t => ({ gene, transcript: t })))
  if (picked) {
    const match = all.find(item => item.transcript.transcript_id === picked)
    if (match) return match
  }
  return null
}

/** Columns per detailed request. The server enforces its own ceiling; this is
 * the quantum that keeps request keys stable while panning, so moving by a few
 * columns re-uses the window already in hand rather than asking again. */
const WINDOW = 16_384
/** Rows per request, matching the server's own bound. */
const ROWS = 8
export const CONTEXT_MAX_COLUMNS = 65_536
export const requestBatches = (items, limit = ROWS) => Array.from({length: Math.ceil(items.length / limit)}, (_, i) => items.slice(i * limit, (i + 1) * limit))

/** The column window to ask about: the visible interval, snapped out to whole
 * quanta and padded one either side so panning back the way you came finds the
 * answer already there. */
export function contextWindow(fragment,camera,size,quantum=WINDOW) {
  if(!fragment)return null
  const rect=panelRect(fragment,camera)
  const from=Math.max(fragment.start,fragment.start+(MARGIN_X-rect.x)/rect.scale)
  const to=Math.min(fragment.end,fragment.start+(size.width-rect.x)/rect.scale)
  if(to<=from)return null
  let start=Math.max(fragment.start,Math.floor(from/quantum)*quantum-quantum)
  let end=Math.min(fragment.end,Math.ceil(to/quantum)*quantum+quantum)
  // Padding must not turn a valid visible window into a rejected request.
  if(to-from<=CONTEXT_MAX_COLUMNS && end-start>CONTEXT_MAX_COLUMNS){
    start=Math.max(fragment.start,Math.floor(from))
    end=Math.min(fragment.end,start+CONTEXT_MAX_COLUMNS)
  }
  return end>start?{start,end}:null
}

/** Which rows to ask about: the ones on screen, and whatever they are being
 * read against. Scrolling a long stack must not load every row's transcripts,
 * but a target whose comparator went unasked could not be compared at all. */
export function contextRows(detail,layer,camera,size,limit=Infinity) {
  if(!detail)return []
  const seen=new Set()
  for(const fragment of layer?.fragments||[]){
    const rect=panelRect(fragment,camera)
    fragment.rowIds.forEach((id,index)=>{
      const y=rect.y+rowSlot(fragment,index)*ROW_HEIGHT
      if(y>=-ROW_HEIGHT*3&&y<size.height+ROW_HEIGHT*3)seen.add(id)
    })
  }
  const wanted=new Set(seen)
  const {pinned}=splitRows(detail)
  if(pinned)wanted.add(pinned)
  for(const id of seen){const against=comparatorFor(detail,id);if(against)wanted.add(against)}
  // Bounded, and in the reader's own order so the first page is the top of the
  // stack rather than an arbitrary set.
  return detail.rows.filter(id=>wanted.has(id)).slice(0,limit)
}

/** The pairs to measure: the visible rows against whatever each is read against.
 *
 * Explicit, and bounded. Nothing infers which rows should be compared - that is
 * the reader's choice of reference or of adjacency, and this only reports it. */
export function contextPairs(detail, layer, camera, size, limit = Infinity) {
  const rows = contextRows(detail, layer, camera, size, limit)
  const pairs = []
  for (const rowId of rows) {
    const against = comparatorFor(detail, rowId)
    if (against && against !== rowId) pairs.push([against, rowId])
  }
  return pairs.slice(0, limit)
}

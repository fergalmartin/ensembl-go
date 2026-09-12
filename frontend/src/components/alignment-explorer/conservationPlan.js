import { planeOf } from './layers.js'
import { MARGIN_X } from './layout.js'

/** Conservation tiles share the sequence stream's discipline - fixed spans, keys
 * independent of the camera envelope and of row order - but not its row
 * batching. One request covers the whole cohort, so this stream is a fraction
 * of the sequence stream's request count, and a bin is either answered for
 * every sequence or not at all. Half a cohort would be a different statistic,
 * not a partial one, and would reshade as batches landed. */
export function planConservationTiles(fragment, camera, size, level, cohort) {
  if (fragment.aggregate || !cohort?.ids.length) return []
  const x = MARGIN_X + (fragment.x - camera.x) * camera.scale
  const width = (fragment.end - fragment.start) * camera.scale
  const padding = 300 / planeOf(camera)
  if (x > size.width + padding || x + width < -padding || width * planeOf(camera) < 2) return []
  const from = Math.max(fragment.start, fragment.start - x / camera.scale)
  const to = Math.min(fragment.end, fragment.start + (size.width - x) / camera.scale)
  if (to <= from) return []
  const step = 2 ** level, span = Math.max(2048, step * 256)
  // Bins are capped at the same bound the region endpoint uses, so a tile never
  // asks for finer than one bin per column.
  const bins = Math.max(16, Math.min(2048, Math.ceil(span / step)))
  const tasks = []
  for (let i = Math.max(0, Math.floor(from / span) - 1); i <= Math.floor((to - 1) / span) + 1; i++) {
    if (i < 0 || i * span >= fragment.end || (i + 1) * span <= fragment.start) continue
    const start = i * span
    tasks.push({ request: { block: fragment.sourceBlock, start, end: start + span, ids: cohort.ids, bins },
      cohortKey: cohort.key, priority: start + span > from && start < to ? 1 : 3 })
  }
  // A fixed coarse parent, as the sequence stream has, so newly exposed area is
  // filled cheaply rather than left blank until the finer tile lands.
  const parentSpan = Math.max(span * 4, 16384)
  for (let start = Math.floor(from / parentSpan) * parentSpan; start < to; start += parentSpan) {
    tasks.push({ request: { block: fragment.sourceBlock, start, end: start + parentSpan, ids: cohort.ids, bins: 256 },
      cohortKey: cohort.key, priority: 0, coarse: true })
  }
  return tasks
}

/** The cohort is the sequences the blocks on the sheet actually hold, narrowing
 * to whatever is picked. Sorted, so the key survives a reorder, and taken from
 * the laid-out blocks rather than the rows that happen to be within the window,
 * so it survives scrolling too.
 *
 * Not the whole inventory. A 200-block MAF names a distinct identity for every
 * sequence in every block - 3,881 of them for 44 mammals - while any one block
 * holds around 45. Measured against the inventory, every bin came out at about
 * a hundredth of the cohort, the second axis went flat, and the answer to "how
 * much of what you are reading is here" was always "almost none".
 */
export function cohortOf(layer, inventory, lit) {
  const laid = (layer?.fragments || []).filter(f => !f.aggregate)
  const available = new Set(laid.flatMap(f => f.availableRows || f.rowIds))
  // An overview merges blocks away and carries no row lists; the inventory is
  // then the only statement of what is being looked at.
  if (!available.size) for (const row of inventory || []) available.add(row.id)
  const picked = [...(lit || [])].filter(id => available.has(id))
  const ids = (picked.length ? picked : [...available]).sort()
  return ids.length ? { ids, key: `${ids.length}:${ids.join(',')}`, picked: picked.length > 0 } : null
}

import { rowSlot, planeOf } from './layers.js'
import { MARGIN_X, MARGIN_Y, ROW_HEIGHT } from './layout.js'

const rowOrders = new WeakMap()
export function planMotifTiles(layer, camera, size) {
  const tasks = new Map(), step = 2 ** Math.max(0, Math.ceil(Math.log2(1 / Math.max(1e-9, camera.scale * planeOf(camera)))))
  const span = step * 1024
  for (const f of layer.fragments) {
    if (f.aggregate) continue
    const x = MARGIN_X + (f.x - camera.x) * camera.scale
    const from = Math.max(f.start, f.start - x / camera.scale), to = Math.min(f.end, f.start + (size.width - x) / camera.scale)
    if (to <= from) continue
    let order = rowOrders.get(f.rowIds)
    if (!order) { const ids = [...f.rowIds].sort(); order = { ids, ranks: new Map(ids.map((id, i) => [id, i])) }; rowOrders.set(f.rowIds, order) }
    const groups = new Set()
    f.rowIds.forEach((id, index) => {
      const y = MARGIN_Y + (f.y + rowSlot(f, index)) * ROW_HEIGHT - camera.y
      if (y > -ROW_HEIGHT && y < size.height + ROW_HEIGHT) groups.add(Math.floor(order.ranks.get(id) / 16))
    })
    for (const group of groups) for (let start = Math.floor(from / span) * span; start < to; start += span) {
      const request = { block: f.sourceBlock, ids: order.ids.slice(group * 16, group * 16 + 16), start, end: start + span, step }
      tasks.set(JSON.stringify(request), request)
    }
  }
  return [...tasks].sort((a, b) => a[1].block - b[1].block || a[1].start - b[1].start)
}

/** Responses are already disjoint priority-resolved runs. No event sweep or
 * match sorting is allowed here: cost depends on viewport tiles, not matches. */
export function collectMotifTiles(tasks, values, palette) {
  const rows = {}, seen = new Set()
  for (const [key] of tasks) {
    const data = values.get(key)
    if (!data) continue
    for (const row of data.rows) {
      const tileKey = `${data.block}:${row.id}:${data.start}:${data.step}`
      if (seen.has(tileKey)) continue
      seen.add(tileKey)
      const target = rows[`${data.block}:${row.id}`] ??= []
      for (const [a, z, index] of row.runs) target.push([a, z, palette[index - 1]])
    }
  }
  return rows
}

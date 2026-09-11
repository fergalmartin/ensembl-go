import { unionRanges } from './layers.js'

/** Column ranges known to hold no bases at all, remembered per block and row.
 *
 * A run of gap is monotonic: if a bin of N columns is entirely '-', so is every
 * column inside it, and so is every finer bin the next zoom level cuts it into.
 * A gap can therefore only ever gain detail as the camera closes in — it can
 * never turn back into sequence.
 *
 * The renderer does not see it that way on its own. It paints whichever tile is
 * to hand, and a coarse bin holding a few bases among mostly gap is drawn filled,
 * so a gap resolved at one zoom is filled back in the moment a coarser tile drives
 * a repaint, and flickers as the two alternate. Remembering the ranges settles
 * it: once known, a gap is drawn from memory whatever the current tile says.
 */
export function createGapMemory() {
  const memory=new Map();memory.rangeCount=0;return memory
}

export const gapKey = (block, rowId) => `${block}:${rowId}`

/** Gap runs a tile proves, at whatever resolution it carries.
 *
 * Detail gives exact runs. Bins give only the bins that are wholly gap: a bin
 * merely containing gap says nothing about where inside it the gap falls, so it
 * contributes nothing rather than a guess. */
export function gapRanges(data, row) {
  if (!data || !row) return []
  const ranges = []
  if (data.detail && typeof row.sequence === 'string') {
    let run = -1
    for (let i = 0; i <= row.sequence.length; i++) {
      const gap = row.sequence[i] === '-'
      if (gap && run < 0) run = i
      else if (!gap && run >= 0) { ranges.push([data.start + run, data.start + i]); run = -1 }
    }
    return ranges
  }
  if (Array.isArray(row.bins) && data.bin_size > 0) {
    row.bins.forEach((bin, i) => {
      const total = Object.values(bin).reduce((n, v) => n + v, 0)
      if (!total || bin['-'] !== total) return
      const a = data.start + i * data.bin_size
      ranges.push([a, Math.min(data.end, a + data.bin_size)])
    })
  }
  return ranges
}

/** Fold a tile's gap runs into the memory. Returns whether anything was new, so
 * a caller can avoid repainting when a tile adds nothing. */
export function rememberGaps(memory, block, data) {
  if (!data?.rows) return false
  let changed = false
  for (const row of data.rows) {
    const found = gapRanges(data, row)
    if (!found.length) continue
    const key = gapKey(block, row.id)
    const before = memory.get(key) || []
    const merged = unionRanges([...before, ...found])
    if (merged.length !== before.length || merged.some((r, i) => r[0] !== before[i][0] || r[1] !== before[i][1])) {
      memory.delete(key);memory.set(key, merged); changed = true
      memory.rangeCount=(memory.rangeCount||0)+merged.length-before.length
      // Gap history is derived data too. Bound sparse, gap-heavy sessions; old
      // rows are recoverable from the persistent source summaries.
      while(memory.size>4096||memory.rangeCount>250000){
        const oldest=memory.keys().next().value
        memory.rangeCount-=memory.get(oldest).length;memory.delete(oldest)
      }
    }
  }
  return changed
}

/** Remembered gaps overlapping a column window and wide enough to be seen.
 *
 * Below a couple of pixels a gap is not a mark, it is noise along the bottom of
 * every block, so it is left out until the camera makes it its own feature. That
 * only ever adds gaps as the view closes in, never removes them. */
export function visibleGaps(memory, block, rowId, start, end, minColumns = 0) {
  const ranges = memory.get(gapKey(block, rowId))
  if (!ranges) return []
  const result = []
  for (const [a, z] of ranges) {
    if (z <= start || a >= end) continue
    if (z - a < minColumns) continue
    result.push([Math.max(a, start), Math.min(z, end)])
  }
  return result
}

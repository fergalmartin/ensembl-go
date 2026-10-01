/**
 * Data views subtree by subtree.
 *
 * The Original tree shows one data view, or none. In a subtree layer each subtree carries
 * its own (`fragment.dataView`, saved with the layer), so one can show its transcripts while
 * another shows its neighbourhoods. The Data view button acts on the subtrees the selection
 * touches, or on all of them when nothing is picked (`viewScope`).
 *
 * Drawing them: one column per view in use, each told which lanes (subtrees) are its own,
 * put together as one column the painter and the canvas already know how to use
 * (`composeColumns`). Subtrees showing Structure or Sequence share one alignment of all
 * their genes, so their columns line up and conservation means the same everywhere.
 */

export const DATA_VIEWS = ['neighbourhood', 'structure', 'sequence']
export const isDataView = view => DATA_VIEWS.includes(view)
export const isAlignmentView = view => view === 'structure' || view === 'sequence'

/**
 * The subtrees the Data view button acts on: those the picks touch (any node of theirs),
 * else every subtree in the layer. `fragmentOf` maps a drawn node to [fragment index, …].
 */
export function viewScope(layer, fragmentOf, picked) {
  const all = (layer?.fragments || []).map(f => f.id)
  if (!picked?.size || !fragmentOf) return { ids: all, selected: false }
  const touched = new Set()
  for (const id of picked) {
    const at = fragmentOf.get(id)
    if (at) touched.add(layer.fragments[at[0]]?.id)
  }
  touched.delete(undefined)
  return touched.size ? { ids: all.filter(id => touched.has(id)), selected: true } : { ids: all, selected: false }
}

/** The view the subtrees `ids` show: one of DATA_VIEWS, 'off', or 'mixed' when they differ. */
export function scopeView(layer, ids) {
  const wanted = new Set(ids)
  const views = new Set((layer?.fragments || []).filter(f => wanted.has(f.id)).map(f => (isDataView(f.dataView) ? f.dataView : 'off')))
  if (!views.size) return 'off'
  return views.size === 1 ? [...views][0] : 'mixed'
}

/** `layer` with the subtrees `ids` showing `view` ('off' clears it). */
export function withFragmentViews(layer, ids, view) {
  const wanted = new Set(ids)
  return {
    ...layer,
    fragments: layer.fragments.map(f => {
      if (!wanted.has(f.id)) return f
      if (isDataView(view)) return { ...f, dataView: view }
      const next = { ...f }
      delete next.dataView
      return next
    }),
  }
}

/**
 * The view a subtree copied into a layer starts with: the layer's, when every subtree in it
 * shows the same one; into an empty layer, the view it was showing where it came from
 * (`fallback`); otherwise none.
 */
export function arrivingView(fragments, fallback) {
  if (!fragments?.length) return isDataView(fallback) ? fallback : undefined
  const views = new Set(fragments.map(f => (isDataView(f.dataView) ? f.dataView : 'off')))
  const [only] = views
  return views.size === 1 && isDataView(only) ? only : undefined
}

/** `fragment` showing `view`, when it is one (a subtree made from others keeps theirs). */
export const carryView = (fragment, view) => (isDataView(view) ? { ...fragment, dataView: view } : fragment)

/** Lane by lane (a laid-out forest's subtrees), the data view each shows, or 'off'. */
export function laneViews(layout, viewOf) {
  const roots = (layout?.items || []).filter(item => item.lane !== undefined && item.node.fragRoot)
  const out = Array.from({ length: roots.reduce((n, item) => Math.max(n, item.lane + 1), 0) }, () => 'off')
  for (const item of roots) {
    const view = viewOf(item.node.fragRoot)
    if (isDataView(view)) out[item.lane] = view
  }
  return out
}

/**
 * Several data columns as one. `parts` are `{column, lanes}`: the column, and the lanes
 * (subtrees) it draws. Painting, hit-testing, the leader to a row and a wheel over a strip
 * each go to the part whose lanes the row is in; a stretching column (an alignment's) sets
 * the label offset of its own lanes (`placeLabels`).
 */
export function composeColumns(parts) {
  const live = parts.filter(p => p.column && p.lanes?.size)
  const laneOf = (layout, id) => layout.byId.get(id)?.lane
  const inLanes = (part, layout) => id => part.lanes.has(laneOf(layout, id))
  const partOf = (layout, item) => live.find(p => p.lanes.has(item.lane)) || null
  const aligned = live.find(p => p.column.kind === 'alignment')?.column || null
  return {
    kind: 'composite',
    parts: live,
    paint(ctx, env) {
      for (const part of live) {
        const mine = inLanes(part, env.layout)
        part.column.paint(ctx, { ...env, shown: env.shown ? id => env.shown(id) && mine(id) : mine })
      }
    },
    leaderEnd(layout, t, item) {
      return partOf(layout, item)?.column.leaderEnd?.(layout, t, item) ?? null
    },
    hit(layout, t, sx, sy, plan) {
      for (const part of live) {
        const found = part.column.hit?.(layout, t, sx, sy, plan, inLanes(part, layout))
        if (found) return found
      }
      return null
    },
    wheel(env, intent, wheel, sx, sy) {
      for (const part of live) {
        if (!part.column.wheel) continue
        const taken = part.column.wheel({ ...env, shown: inLanes(part, env.layout) }, intent, wheel, sx, sy)
        if (taken) return taken
      }
      return null
    },
    takePan() {
      return live.reduce((sum, part) => sum + (part.column.takePan?.() || 0), 0)
    },
    /** Each stretching part's width on its own lanes; the layout's `labelOffset` the widest. */
    placeLabels(layout) {
      if (!layout.laneOffsets) return
      for (const part of live) {
        if (!part.column.labelOffset) continue
        const width = part.column.labelOffset()
        for (const lane of part.lanes) layout.laneOffsets[lane] = width
      }
      let widest = 0
      for (const width of layout.laneOffsets) widest = Math.max(widest, width || 0)
      layout.labelOffset = widest
    },
    get conservation() { return live.map(p => p.column.conservation).find(Boolean) || null },
    agreement(a, b) { return aligned?.agreement(a, b) ?? null },
    baseShare(row, c) { return aligned?.baseShare(row, c) ?? null },
    rowShare(row, a, b) { return aligned?.rowShare(row, a, b) ?? null },
  }
}

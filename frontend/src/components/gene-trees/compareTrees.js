/**
 * Comparing two subtrees of a layer (a tanglegram): which leaves stand for each other, and
 * where the two trees agree.
 *
 * Leaves are matched by species, symbol or gene ID (`MATCH_BY`). A match is one-to-one when
 * each leaf has only the other as its partner; a species with several genes in either tree
 * (paralogues) links every copy to every copy, and those links are one-to-many.
 *
 * Agreement is measured on the one-to-one leaves only, as unrooted splits: each branch cuts
 * the matched leaves in two, and a branch is shared when the other tree has a branch cutting
 * them the same way. Rooting is ignored, so two methods that root the same tree differently
 * do not disagree everywhere. Sets of leaves are hashed (a random 64 bits per leaf, XORed),
 * so a split is compared in constant time however big the tree.
 *
 * Everything here is in the ids of the layer's forest (workspace.js `forestTree`), and
 * nothing recurses, as in treeModel.js.
 */
import { isLeaf, orderedChildren } from './treeModel.js'

export const MATCH_BY = [
  { id: 'species', label: 'Species', hint: 'Join genes from the same species' },
  { id: 'symbol', label: 'Symbol', hint: 'Join genes with the same gene symbol' },
  { id: 'id', label: 'Gene ID', hint: 'Join the same gene (or protein or transcript) ID, ignoring versions' },
]

const bare = value => String(value || '').trim().replace(/^(.+?\d{5,})\.\d+$/, '$1').toUpperCase()

/** What a leaf is matched on: every key it can be found by (an ID leaf has several). */
export function matchKeys(leaf, by) {
  if (!leaf) return []
  if (by === 'symbol') {
    const symbol = String(leaf.symbol || '').trim().toUpperCase()
    return symbol ? [symbol] : []
  }
  if (by === 'id') {
    return [...new Set([leaf.gene_id, leaf.protein_id, leaf.transcript_id, leaf.other_id].filter(Boolean).map(bare))]
  }
  const species = String(leaf.species || '').trim().toLowerCase().replace(/[_\s]+/g, ' ')
  return species ? [species] : []
}

/** The leaves under `root`, top to bottom as drawn with `view`'s flips (all of them, folded or not). */
export function leafOrder(index, view, root) {
  const out = []
  const stack = [root]
  while (stack.length) {
    const id = stack.pop()
    if (isLeaf(index, id)) { out.push(id); continue }
    const children = orderedChildren(index, view, id)
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i])
  }
  return out
}

/**
 * The lines between two subtrees (roots `rootA` and `rootB` in `index`): `links` as
 * `{a, b, oneToOne}`, `partners` (leaf → the leaves it is joined to, either way), and the
 * leaves joined to nothing (`onlyA`, `onlyB`).
 */
export function compareLinks(index, rootA, rootB, by) {
  const leavesA = leafOrder(index, { flipped: new Set() }, rootA)
  const leavesB = leafOrder(index, { flipped: new Set() }, rootB)
  const byKey = new Map()
  for (const id of leavesB) {
    for (const key of matchKeys(index.nodes[id].leaf, by)) {
      if (!byKey.has(key)) byKey.set(key, [])
      byKey.get(key).push(id)
    }
  }
  const partners = new Map()
  const join = (from, to) => {
    if (!partners.has(from)) partners.set(from, [])
    partners.get(from).push(to)
  }
  const pairs = []
  for (const a of leavesA) {
    const found = new Set()
    for (const key of matchKeys(index.nodes[a].leaf, by)) for (const b of byKey.get(key) || []) found.add(b)
    for (const b of found) { pairs.push([a, b]); join(a, b); join(b, a) }
  }
  const links = pairs.map(([a, b]) => ({ a, b, oneToOne: partners.get(a).length === 1 && partners.get(b).length === 1 }))
  return { links, partners, onlyA: leavesA.filter(id => !partners.has(id)), onlyB: leavesB.filter(id => !partners.has(id)) }
}

// A random 64-bit tag per leaf, as two 32-bit halves: a set of leaves is the XOR of its tags.
function tags(count, seed = 0x9e3779b9) {
  let s = seed >>> 0
  const next = () => {
    // xorshift32
    s ^= s << 13; s >>>= 0
    s ^= s >>> 17
    s ^= s << 5; s >>>= 0
    return s
  }
  const hi = new Uint32Array(count), lo = new Uint32Array(count)
  for (let i = 0; i < count; i++) { hi[i] = next(); lo[i] = next() }
  return { hi, lo }
}

/**
 * Every branch of the subtree under `root` as an unrooted split of the matched leaves
 * (`slot`: leaf id → its pair's number, 0..n-1). Returns node id → `{key, size}`, where
 * `size` is how many matched leaves are under the node and `key` names the split the same
 * way from either side (normalised to the side without pair 0). Splits that cut off fewer
 * than two leaves on either side say nothing and are left out.
 */
export function splits(index, root, slot, n, tag = tags(n)) {
  const order = []
  const stack = [root]
  while (stack.length) {
    const id = stack.pop()
    order.push(id)
    stack.push(...index.nodes[id].children)
  }
  const hi = new Map(), lo = new Map(), size = new Map(), hasFirst = new Map()
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i]
    let h = 0, l = 0, s = 0, first = false
    const pair = slot.get(id)
    if (pair !== undefined) { h = tag.hi[pair]; l = tag.lo[pair]; s = 1; first = pair === 0 }
    for (const child of index.nodes[id].children) {
      h ^= hi.get(child); l ^= lo.get(child); s += size.get(child); first ||= hasFirst.get(child)
    }
    hi.set(id, h >>> 0); lo.set(id, l >>> 0); size.set(id, s); hasFirst.set(id, first)
  }
  // The whole set, to take the other side of a split that holds pair 0.
  let allHi = 0, allLo = 0
  for (let i = 0; i < n; i++) { allHi ^= tag.hi[i]; allLo ^= tag.lo[i] }
  const out = new Map()
  for (const id of order) {
    if (id === root) continue
    const s = size.get(id)
    if (s < 2 || n - s < 2) continue
    const flip = hasFirst.get(id)
    const key = flip ? `${(hi.get(id) ^ allHi) >>> 0}:${(lo.get(id) ^ allLo) >>> 0}` : `${hi.get(id)}:${lo.get(id)}`
    out.set(id, { key, size: s })
  }
  return out
}

/**
 * Where two subtrees agree, from `compareLinks`' links: the branches whose split the other
 * tree shares (`shared`) or does not (`conflict`), both sets of node ids across both trees;
 * a colour group for each one-to-one leaf (`groups`, leaf id → group number, by the biggest
 * shared clade it sits in, at most half the leaves); the leaves under a conflicting branch
 * in either tree (`unsettled`); and counts.
 */
export function agreement(index, rootA, rootB, links) {
  const pairs = links.filter(link => link.oneToOne)
  const n = pairs.length
  const slotA = new Map(pairs.map((link, i) => [link.a, i]))
  const slotB = new Map(pairs.map((link, i) => [link.b, i]))
  const tag = tags(Math.max(1, n))
  const splitsA = splits(index, rootA, slotA, n, tag)
  const splitsB = splits(index, rootB, slotB, n, tag)
  const keysA = new Set([...splitsA.values()].map(s => s.key))
  const keysB = new Set([...splitsB.values()].map(s => s.key))
  const shared = new Set(), conflict = new Set()
  for (const [id, s] of splitsA) (keysB.has(s.key) ? shared : conflict).add(id)
  for (const [id, s] of splitsB) (keysA.has(s.key) ? shared : conflict).add(id)
  // Each shared branch's twin in the other tree (the first with the same split).
  const counterpart = new Map()
  const firstWith = splitsOf => {
    const out = new Map()
    for (const [id, s] of splitsOf) if (!out.has(s.key)) out.set(s.key, id)
    return out
  }
  const byKeyA = firstWith(splitsA), byKeyB = firstWith(splitsB)
  for (const [id, s] of splitsA) if (byKeyB.has(s.key)) counterpart.set(id, byKeyB.get(s.key))
  for (const [id, s] of splitsB) if (byKeyA.has(s.key)) counterpart.set(id, byKeyA.get(s.key))

  // Colour groups: down tree A from its root, the first shared clade of at most half the
  // matched leaves takes a colour for every matched leaf under it; their partners share it.
  const groups = new Map()
  let group = 0
  const stack = [rootA]
  while (stack.length) {
    const id = stack.pop()
    const s = splitsA.get(id)
    if (s && shared.has(id) && s.size <= n - s.size) {
      const g = group++
      const inner = [id]
      while (inner.length) {
        const next = inner.pop()
        if (slotA.has(next)) {
          groups.set(next, g)
          groups.set(pairs[slotA.get(next)].b, g)
        }
        inner.push(...index.nodes[next].children)
      }
      continue
    }
    stack.push(...index.nodes[id].children)
  }

  // Leaves under a conflicting branch, in either tree: their lines are the ones in question.
  const unsettled = new Set()
  for (const id of conflict) {
    const inner = [id]
    while (inner.length) {
      const next = inner.pop()
      if (slotA.has(next)) { unsettled.add(next); unsettled.add(pairs[slotA.get(next)].b) }
      if (slotB.has(next)) { unsettled.add(next); unsettled.add(pairs[slotB.get(next)].a) }
      inner.push(...index.nodes[next].children)
    }
  }
  const distinct = map => new Set([...map.values()].map(s => s.key)).size
  const sharedCount = [...keysA].filter(key => keysB.has(key)).length
  return {
    shared, conflict, groups, unsettled, counterpart, groupCount: group,
    stats: { matched: n, cladesA: distinct(splitsA), cladesB: distinct(splitsB), shared: sharedCount,
      conflictA: keysA.size - sharedCount, conflictB: keysB.size - sharedCount },
  }
}

/**
 * How many lines cross, with each tree's leaves ranked top to bottom (`rank`: leaf id → row):
 * pairs of lines whose ends are in opposite orders. Lines sharing an end never cross. Counted
 * as inversions while merge-sorting, so a big comparison costs n log n, not n².
 */
export function crossings(links, rank) {
  const rows = links.map(link => [rank.get(link.a), rank.get(link.b)]).filter(([a, b]) => a !== undefined && b !== undefined)
  rows.sort((p, q) => p[0] - q[0] || p[1] - q[1])
  let values = rows.map(r => r[1])
  let count = 0
  let buffer = new Array(values.length)
  for (let width = 1; width < values.length; width *= 2) {
    for (let lo = 0; lo < values.length; lo += width * 2) {
      const mid = Math.min(lo + width, values.length), hi = Math.min(lo + width * 2, values.length)
      let i = lo, j = mid, k = lo
      while (i < mid && j < hi) {
        // Strictly greater only: equal rows on the right-hand side share an end and do not cross.
        if (values[j] < values[i]) { count += mid - i; buffer[k++] = values[j++] } else buffer[k++] = values[i++]
      }
      while (i < mid) buffer[k++] = values[i++]
      while (j < hi) buffer[k++] = values[j++]
    }
    ;[values, buffer] = [buffer, values]
  }
  return count
}

const rankOf = (index, view, root) => new Map(leafOrder(index, view, root).map((id, i) => [id, i]))

/**
 * Order one tree's branches to follow the other's leaves (the barycentre heuristic): at
 * each node of the tree under `root`, its children are kept in order or flipped, whichever
 * puts their partners' mean rows (`target`: leaf id → row in the other tree) in order.
 */
function follow(index, view, root, partners, target) {
  const flipped = new Set(view.flipped)
  const order = []
  const stack = [root]
  while (stack.length) {
    const id = stack.pop()
    order.push(id)
    stack.push(...index.nodes[id].children)
  }
  // The mean row of the partners of the leaves under each node, bottom up.
  const sum = new Map(), count = new Map()
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i]
    let s = 0, c = 0
    for (const other of partners.get(id) || []) {
      const row = target.get(other)
      if (row !== undefined) { s += row; c += 1 }
    }
    for (const child of index.nodes[id].children) { s += sum.get(child); c += count.get(child) }
    sum.set(id, s); count.set(id, c)
  }
  for (const id of order) {
    const children = index.nodes[id].children
    if (children.length < 2) continue
    const drawn = flipped.has(id) ? [...children].reverse() : children
    const means = drawn.map(c => (count.get(c) ? sum.get(c) / count.get(c) : null)).filter(m => m !== null)
    // Pairs out of order against pairs in order: flip when more are out than in.
    let inOrder = 0, outOfOrder = 0
    for (let i = 0; i < means.length; i++) {
      for (let j = i + 1; j < means.length; j++) {
        if (means[i] < means[j]) inOrder += 1
        else if (means[i] > means[j]) outOfOrder += 1
      }
    }
    if (outOfOrder > inOrder) {
      if (flipped.has(id)) flipped.delete(id)
      else flipped.add(id)
    }
  }
  return { ...view, flipped }
}

/**
 * Flip branches of both subtrees so the lines between them cross as little as they can:
 * tree B follows tree A, then A follows B, twice over. Returns the new view (only `flipped`
 * changes) and the crossings before and after.
 */
export function untangle(index, view, rootA, rootB, links, partners) {
  const before = crossings(links, new Map([...rankOf(index, view, rootA), ...rankOf(index, view, rootB)]))
  let next = view
  for (let round = 0; round < 2; round++) {
    next = follow(index, next, rootB, partners, rankOf(index, next, rootA))
    next = follow(index, next, rootA, partners, rankOf(index, next, rootB))
  }
  const after = crossings(links, new Map([...rankOf(index, next, rootA), ...rankOf(index, next, rootB)]))
  // Never leave it worse than it was.
  return after <= before ? { view: next, before, after } : { view, before, after: before }
}

/** The crossings as the trees are drawn now. */
export function currentCrossings(index, view, rootA, rootB, links) {
  return crossings(links, new Map([...rankOf(index, view, rootA), ...rankOf(index, view, rootB)]))
}

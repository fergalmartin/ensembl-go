/**
 * The Neighbourhood data view's pure parts: which leaves it asks about, how genes in
 * different rows are matched (by gene family, else by symbol), which neighbours each pair
 * of rows links, and the colours of the families shared down the column. (Kept apart
 * from the fetching, so they can be tested without the app.)
 */
export const NEIGHBOURHOOD_FLANK = 4
export const FLANK_CHOICES = [2, 3, 4, 6]

// "Most shared": colour only the few families beside the tree gene in the most rows and
// leave the rest in the Neighbourhood view's blue, so a colour stands out rather than every
// gene shouting. No blue (the plain genes), orange (the tree gene) or yellow (picks), and
// never cycled. Dark: every pair clears colour-blind separation; light: legal because
// each gene also carries its name and links.
export const FAMILY_PALETTE = Object.freeze({
  light: Object.freeze(['#1baf7a', '#4a3aa7', '#e87ba4']),
  dark: Object.freeze(['#199e70', '#9085e9', '#e87ba4']),
})
// "All shared": every family in two or more rows gets a colour, cycling when they run out.
export const NEIGHBOUR_PALETTE = Object.freeze(['#00b692', '#ec4899', '#8b5cf6', '#84cc16', '#06b6d4', '#d946ef', '#10b981', '#a78bfa', '#f472b6', '#65a30d'])

const keyOf = link => `${link.assembly}:${link.gene.id}`

/** The linked leaves of a tree or layer: leaf id → `assembly:gene`. */
export function linkedLeaves(nodes, links) {
  const out = new Map()
  for (const node of nodes || []) {
    if (!node.leaf) continue
    const link = links?.[node.id]
    if (link?.status === 'linked' && link.assembly && link.gene?.id) out.set(node.id, keyOf(link))
  }
  return out
}

/** A gene's symbol for matching across genomes: its name, case aside. Unnamed genes never match. */
export const symbolOf = gene => String(gene?.name || '').trim().toLowerCase()

/**
 * How genes are matched across rows. `by` is 'family' (the library trees each gene is in,
 * falling back to its symbol where a genome's genes are in no tree) or 'symbol'.
 *
 * A gene's keys are `f:<tree>` for each family it is in, or `s:<symbol>`. With families on,
 * a gene without any borrows the family its namesakes elsewhere are in, so a RefSeq row
 * still lines up with Ensembl rows that have family data. `keys(gene)[0]` is the gene's
 * group, what colours and hovering go by.
 */
export function buildMatcher(byLeafId, by = 'family') {
  const families = by === 'family'
  const symbolFamily = new Map()
  if (families) {
    const counts = new Map()
    for (const entry of byLeafId.values()) {
      for (const gene of entry?.genes || []) {
        const symbol = symbolOf(gene)
        if (!symbol || !gene.families?.length) continue
        const key = `${symbol}\u0001${gene.families[0]}`
        counts.set(key, (counts.get(key) || 0) + 1)
      }
    }
    // A symbol's family is the one most of its genes are in.
    const best = new Map()
    for (const [key, n] of counts) {
      const [symbol, family] = key.split('\u0001')
      if (n > (best.get(symbol)?.n || 0)) best.set(symbol, { family, n })
    }
    for (const [symbol, { family }] of best) symbolFamily.set(symbol, `f:${family}`)
  }
  const cache = new Map()
  const keys = gene => {
    if (!gene) return []
    let out = cache.get(gene)
    if (out) return out
    const symbol = symbolOf(gene)
    if (families && gene.families?.length) out = gene.families.map(f => `f:${f}`)
    else if (symbol) out = [symbolFamily.get(symbol) || `s:${symbol}`]
    else out = []
    cache.set(gene, out)
    return out
  }
  /** How two genes are related: 'family' (both in one tree), 'symbol' (by name), or null. */
  const related = (a, b) => {
    const ka = keys(a)
    if (!ka.length) return null
    const kb = keys(b)
    if (!kb.some(k => ka.includes(k))) return null
    return families && a.families?.length && b.families?.length ? 'family' : 'symbol'
  }
  const group = gene => keys(gene)[0] || ''
  return { by, keys, related, group }
}

/**
 * The groups shared between rows: every group (family or symbol) found beside the tree
 * gene in two or more rows, the rows' own gene aside. `{rows: Map(group → row count),
 * order: [group…]}`, most rows first, then by name, so a group keeps its place as rows
 * come and go.
 */
export function sharedGroups(byLeafId, matcher) {
  const rows = new Map()
  for (const entry of byLeafId.values()) {
    if (!entry?.genes) continue
    const seen = new Set()
    for (const gene of entry.genes) {
      const group = matcher.group(gene)
      if (!group || gene.id === entry.center || seen.has(group)) continue
      seen.add(group)
      rows.set(group, (rows.get(group) || 0) + 1)
    }
  }
  const order = [...rows].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([g]) => g)
  return { rows, order }
}

/**
 * Colours for the shared groups. 'top': the first of `order` take the palette's colours,
 * one each, and the rest none. 'all': every shared group, the palette cycling. 'plain': none.
 */
export function groupColours(order, mode, isLight = false) {
  if (mode === 'all') return new Map(order.map((g, i) => [g, NEIGHBOUR_PALETTE[i % NEIGHBOUR_PALETTE.length]]))
  if (mode !== 'top') return new Map()
  const palette = FAMILY_PALETTE[isLight ? 'light' : 'dark']
  return new Map(order.slice(0, palette.length).map((g, i) => [g, palette[i]]))
}

/**
 * Which genes of two rows are linked: `[{a, b, via}]` by index into each row's genes.
 * Each gene links at most once; where there is a choice (tandem copies), the pairs that
 * sit closest to the same place in their rows win, as in the Neighbourhood view.
 */
export function pairRows(upper, lower, matcher) {
  if (!upper?.genes?.length || !lower?.genes?.length) return []
  const centreOf = entry => Math.max(0, entry.genes.findIndex(g => g.id === entry.center))
  const cu = centreOf(upper), cl = centreOf(lower)
  const candidates = []
  upper.genes.forEach((ga, a) => {
    lower.genes.forEach((gb, b) => {
      const via = matcher.related(ga, gb)
      if (via) candidates.push({ a, b, via, d: Math.abs((a - cu) - (b - cl)) })
    })
  })
  candidates.sort((x, y) => x.d - y.d || x.a - y.a || x.b - y.b)
  const usedA = new Set(), usedB = new Set(), out = []
  for (const { a, b, via } of candidates) {
    if (usedA.has(a) || usedB.has(b)) continue
    usedA.add(a); usedB.add(b)
    out.push({ a, b, via })
  }
  return out
}

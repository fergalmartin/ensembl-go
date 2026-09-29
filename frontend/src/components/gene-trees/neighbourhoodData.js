/**
 * The Neighbourhood data view: the genes around each linked leaf's gene in its local
 * genome, fetched in batches and remembered, plus the colours that make shared neighbours
 * line up down the column.
 */
import { useEffect, useMemo, useState } from 'react'
import { api } from './data.js'

export const NEIGHBOURHOOD_FLANK = 4
// Shared neighbours' colours: none orange or red (the centre gene is orange) and none the
// plain genes' blue, so a colour always means "this gene is in other rows too".
export const NEIGHBOUR_PALETTE = Object.freeze(['#00b692', '#ec4899', '#8b5cf6', '#84cc16', '#06b6d4', '#d946ef', '#10b981', '#a78bfa', '#f472b6', '#65a30d'])
const CHUNK = 200

// Answers for `assembly:gene`, kept for the visit: switching trees or layers asks again only
// for genes not seen yet.
const CACHE = new Map()

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

/**
 * The neighbourhoods of what is on show: `{byLeafId: Map(leafId → {genes, center} | {error}),
 * pending: Set(leafId)}`. Nothing is fetched while `enabled` is false.
 */
export function useNeighbourhoods(nodes, links, enabled) {
  const wanted = useMemo(() => (enabled ? linkedLeaves(nodes, links) : new Map()), [nodes, links, enabled])
  const [version, setVersion] = useState(0)

  useEffect(() => {
    const missing = [...new Set(wanted.values())].filter(key => !CACHE.has(key))
    if (!missing.length) return undefined
    const controller = new AbortController()
    ;(async () => {
      for (let i = 0; i < missing.length; i += CHUNK) {
        const chunk = missing.slice(i, i + CHUNK)
        try {
          const genes = chunk.map(key => {
            const at = key.indexOf(':')
            return { assembly: key.slice(0, at), gene_id: key.slice(at + 1) }
          })
          const { results } = await api('/neighbourhood', { genes, flank: NEIGHBOURHOOD_FLANK }, controller.signal)
          for (const key of chunk) CACHE.set(key, results?.[key] || { error: 'not found' })
        } catch (err) {
          if (err.name === 'AbortError') return
          for (const key of chunk) CACHE.set(key, { error: err.message || 'failed' })
        }
        setVersion(v => v + 1)
      }
    })()
    return () => controller.abort()
  }, [wanted])

  return useMemo(() => {
    const byLeafId = new Map()
    const pending = new Set()
    for (const [leafId, key] of wanted) {
      if (CACHE.has(key)) byLeafId.set(leafId, CACHE.get(key))
      else pending.add(leafId)
    }
    return { byLeafId, pending }
    // `version` marks the cache having grown.
  }, [wanted, version]) // eslint-disable-line react-hooks/exhaustive-deps
}

/** A gene's symbol for matching across genomes: its name, case aside. Unnamed genes never match. */
export const symbolOf = gene => String(gene?.name || '').trim().toLowerCase()

/**
 * Colours for the neighbours that are shared: every symbol that appears in two or more rows
 * (other than as a row's own centre gene) gets a palette colour, handed out in order of how
 * many rows have it, then alphabetically, so the same gene keeps its colour as rows come
 * and go. Returns `{colours: Map(symbol → colour), rows: Map(symbol → row count)}`.
 */
export function sharedColours(byLeafId, palette = NEIGHBOUR_PALETTE) {
  const rows = new Map()
  for (const entry of byLeafId.values()) {
    if (!entry?.genes) continue
    const seen = new Set()
    for (const gene of entry.genes) {
      const symbol = symbolOf(gene)
      if (!symbol || gene.id === entry.center || seen.has(symbol)) continue
      seen.add(symbol)
      rows.set(symbol, (rows.get(symbol) || 0) + 1)
    }
  }
  const shared = [...rows].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const colours = new Map(shared.map(([symbol], i) => [symbol, palette[i % palette.length]]))
  return { colours, rows }
}

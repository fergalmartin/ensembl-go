/**
 * The Neighbourhood data view: the genes around each linked leaf's gene in its local
 * genome, each with the gene families (library trees) it is in, fetched in batches and
 * remembered.
 */
import { useEffect, useMemo, useState } from 'react'
import { api } from './data.js'
import { NEIGHBOURHOOD_FLANK, linkedLeaves } from './neighbourhoodMatch.js'

export { FAMILY_PALETTE, FLANK_CHOICES, NEIGHBOUR_PALETTE, NEIGHBOURHOOD_FLANK, buildMatcher, groupColours, linkedLeaves, pairRows, sharedGroups, symbolOf } from './neighbourhoodMatch.js'

const CHUNK = 200

// Answers for `flank|assembly:gene`, kept for the visit: switching trees or layers asks
// again only for genes not seen yet. Family names (tree id → {name, collection…}) likewise.
const CACHE = new Map()
const FAMILIES = new Map()

/**
 * The neighbourhoods of what is on show: `{byLeafId: Map(leafId → {genes, center} | {error}),
 * pending: Set(leafId), families: Map(tree id → {name, collection…})}`. Nothing is fetched
 * while `enabled` is false.
 */
export function useNeighbourhoods(nodes, links, enabled, flank = NEIGHBOURHOOD_FLANK) {
  const wanted = useMemo(() => (enabled ? linkedLeaves(nodes, links) : new Map()), [nodes, links, enabled])
  const [version, setVersion] = useState(0)

  useEffect(() => {
    const missing = [...new Set(wanted.values())].filter(key => !CACHE.has(`${flank}|${key}`))
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
          const reply = await api('/neighbourhood', { genes, flank, families: true }, controller.signal)
          for (const [id, info] of Object.entries(reply.families || {})) FAMILIES.set(id, info)
          for (const key of chunk) CACHE.set(`${flank}|${key}`, reply.results?.[key] || { error: 'not found' })
        } catch (err) {
          if (err.name === 'AbortError') return
          for (const key of chunk) CACHE.set(`${flank}|${key}`, { error: err.message || 'failed' })
        }
        setVersion(v => v + 1)
      }
    })()
    return () => controller.abort()
  }, [wanted, flank])

  return useMemo(() => {
    const byLeafId = new Map()
    const pending = new Set()
    for (const [leafId, key] of wanted) {
      const hit = CACHE.get(`${flank}|${key}`)
      if (hit) byLeafId.set(leafId, hit)
      else pending.add(leafId)
    }
    return { byLeafId, pending, families: FAMILIES }
    // `version` marks the cache having grown.
  }, [wanted, flank, version]) // eslint-disable-line react-hooks/exhaustive-deps
}

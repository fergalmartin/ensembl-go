import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from './data.js'
import { layerLinkRequests, leafLinkKey, resolveLayerLinks } from './leafLinks.js'

/** Local links are live data, outside the saved workspace and its undo history. */
export default function useLayerLinks(layers, genomeKey, collections) {
  // Names, positions and data views can change without requiring a new gene lookup.
  const requestKey = useMemo(() => JSON.stringify(layerLinkRequests(layers)), [layers])
  const [resolved, setResolved] = useState({ key: '', links: new Map() })
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    let timer
    const refresh = async () => {
      try {
        const result = await resolveLayerLinks(JSON.parse(requestKey), api, controller.signal)
        if (controller.signal.aborted) return
        const key = JSON.stringify([...result.links])
        setResolved(prev => prev.key === key ? prev : { key, links: result.links })
        setError('')
        // Downloads/indexing can finish on disk without changing the registered list.
        if (result.links.size) timer = setTimeout(refresh, result.pending ? 1500 : 30000)
      } catch (err) {
        if (!controller.signal.aborted) {
          setError(`Saved subtree genome links could not be refreshed: ${err.message}`)
          timer = setTimeout(refresh, 5000)
        }
      }
    }
    refresh()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [requestKey, genomeKey, collections])
  const resolveLink = useCallback((node, source) => resolved.links.get(leafLinkKey(node, source)) || node.link, [resolved])
  return { resolveLink, layerLinks: resolved.links, error }
}

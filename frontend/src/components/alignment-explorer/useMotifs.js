import { useEffect, useMemo, useRef, useState } from 'react'
import { api, visibleRequest } from './data'
import { TileScheduler } from './tileScheduler'
import { motifSearchKey, resolveMotifSpans } from './motifs'

export default function useMotifs(dataset, layer, camera, size, motifs, enabled, revision) {
  const [tick, repaint] = useState(0)
  const owner = useRef(Symbol('motifs'))
  const cache = useMemo(() => new TileScheduler({ concurrency: 2, maxEntries: 256, maxBytes: 16 * 1024 * 1024 }), [dataset?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const off = cache.subscribe(() => repaint(n => n + 1))
    return () => { off(); cache.clear() }
  }, [cache])
  useEffect(() => { cache.retryFailed() }, [cache, revision])
  const definitions = enabled ? motifSearchKey(motifs) : '[]'
  const requests = new Map()
  if (dataset && definitions !== '[]') for (const fragment of layer.fragments) {
    const request = visibleRequest(fragment, camera, size)
    if (request) for (const row of request.ids) {
      const key = JSON.stringify([request.block, row, definitions])
      requests.set(key, { block: request.block, row })
    }
  }
  const signature = JSON.stringify([...requests])
  useEffect(() => {
    // Debounce editing, while immediately hiding results for old definitions.
    cache.setWanted([], owner.current)
    if (!dataset) return
    const timer = setTimeout(() => cache.setWanted(JSON.parse(signature).map(([key, request]) => ({
      key, run: signal => api(`/datasets/${dataset.id}/motifs`, { ...request, motifs: JSON.parse(definitions) }, signal),
    })), owner.current), 200)
    return () => clearTimeout(timer)
  }, [cache, dataset, signature, definitions])
  return useMemo(() => {
    const rows = {}, errors = {}
    let pending = false, failure = ''
    for (const [key, request] of JSON.parse(signature)) {
      const result = cache.get(key)
      if (result) {
        rows[`${request.block}:${request.row}`] = resolveMotifSpans(motifs, result.spans)
        Object.assign(errors, result.errors)
      } else if (cache.failed.has(key)) failure = cache.failed.get(key).message
      else pending = true
    }
    return { rows, errors, pending, failure }
  }, [cache, signature, motifs, tick]) // eslint-disable-line react-hooks/exhaustive-deps -- cache publications invalidate the resolved spans
}

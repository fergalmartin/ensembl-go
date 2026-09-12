import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from './data'
import { TileScheduler } from './tileScheduler'
import { planMotifTiles, collectMotifTiles } from './motifTiles'

/** Read-only rendering. Navigation never queues searches or changes the layout. */
export default function useMotifs(snapshot, layer, camera, size, enabled) {
  const [tick, repaint] = useState(0), owner = useRef(Symbol('motif-tiles'))
  const cache = useMemo(() => new TileScheduler({ concurrency: 2, maxEntries: 256, maxBytes: 24 * 1024 * 1024 }), [snapshot?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let frame = null
    const off = cache.subscribe(() => { if (frame == null) frame = requestAnimationFrame(() => { frame = null; repaint(n => n + 1) }) })
    return () => { off(); if (frame != null) cancelAnimationFrame(frame); cache.clear() }
  }, [cache])
  const tasks = enabled && snapshot?.id ? planMotifTiles(layer, camera, size) : []
  const signature = JSON.stringify(tasks)
  useEffect(() => {
    cache.setWanted(JSON.parse(signature).map(([key, request]) => ({ key,
      run: signal => api(`/motif-jobs/${snapshot.id}/region`, request, signal),
    })), owner.current)
  }, [cache, signature, snapshot?.id])
  const palette = useMemo(() => snapshot?.settings.motifs.filter(m => m.enabled && m.pattern).map(m => m.color) || [], [snapshot?.settings.motifs])
  return useMemo(() => {
    const planned = JSON.parse(signature), values = new Map()
    let pending = false, failure = ''
    for (const [key] of planned) {
      const value = cache.get(key)
      if (value) values.set(key, value)
      else if (cache.failed.has(key)) failure = cache.failed.get(key).message
      else pending = true
    }
    return { rows: collectMotifTiles(planned, values, palette), pending, failure }
  }, [cache, signature, palette, tick]) // eslint-disable-line react-hooks/exhaustive-deps -- cache publication invalidates tile collection
}

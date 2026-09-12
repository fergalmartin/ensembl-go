import { useEffect, useState } from 'react'
import { api } from './data'
import { motifSearchKey } from './motifs'

export default function useMotifBlocks(dataset, motifs, enabled, revision) {
  const definitions = motifSearchKey(motifs), key = `${dataset?.id}:${definitions}:${revision}`
  const [result, setResult] = useState(null)
  useEffect(() => {
    if (!enabled || !dataset || definitions === '[]') return
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      const blocks = []
      let after = 0, scanned = 0
      try {
        do {
          const page = await api(`/datasets/${dataset.id}/motif-blocks`, { motifs: JSON.parse(definitions), after }, controller.signal)
          if (controller.signal.aborted) return
          blocks.push(...page.blocks); scanned += page.scanned; after = page.next
          setResult({ key, scanned, blocks: after == null ? blocks : null })
        } while (after != null)
      } catch (error) {
        if (!controller.signal.aborted) setResult({ key, error: error.message })
      }
    }, 300)
    return () => { clearTimeout(timer); controller.abort() }
  }, [dataset, definitions, enabled, key])
  if (!enabled || !dataset || definitions === '[]') return { blocks: null, pending: false, message: enabled ? 'Enable a non-empty motif to hide non-matching blocks.' : '' }
  if (result?.key !== key) return { blocks: null, pending: true, message: 'Searching all blocks…' }
  if (result.error) return { blocks: null, pending: false, message: result.error, error: true }
  return { blocks: result.blocks, pending: !result.blocks,
    message: result.blocks ? `${result.blocks.length.toLocaleString()} matching blocks of ${result.scanned.toLocaleString()}.` : `Searching all blocks… ${result.scanned.toLocaleString()} checked.` }
}

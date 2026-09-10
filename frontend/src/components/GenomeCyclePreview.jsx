import { useEffect, useRef, useState } from 'react'
import { API_BASE } from '../backendRuntime'

// A small gene overview at exactly the locus the browser would initially open.
// Fetch only nearby faces, without mounting a second live browser or activating it.
export default function GenomeCyclePreview({ entry, nearby }) {
  const host = useRef(null)
  const [overview, setOverview] = useState(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!entry.preview) return
    const element = host.current
    element.appendChild(entry.preview)
    return () => element.replaceChildren()
  }, [entry])
  useEffect(() => {
    if (entry.preview || !nearby || overview || failed) return
    const controller = new AbortController()
    async function load() {
      try {
        const params = new URLSearchParams({ genome: entry.key })
        const response = await fetch(`${API_BASE}/api/browse/default_locus?${params}`, { signal: controller.signal })
        if (!response.ok) throw new Error('Preview unavailable')
        const locus = await response.json()
        if (!locus.chrom || !Number.isFinite(locus.start) || !(locus.end > locus.start)) throw new Error('Invalid locus')
        const genesResponse = await fetch(`${API_BASE}/api/browse/genes?${new URLSearchParams({ genome: entry.key, chrom: locus.chrom, start: locus.start, end: locus.end })}`, { signal: controller.signal })
        if (!genesResponse.ok) throw new Error('Annotation unavailable')
        const genes = await genesResponse.json()
        if (!controller.signal.aborted) setOverview({ ...locus, genes: Array.isArray(genes) ? genes : [] })
      } catch (error) {
        if (error.name !== 'AbortError' && !controller.signal.aborted) setFailed(true)
      }
    }
    load()
    return () => controller.abort()
  }, [entry, nearby, overview, failed])
  if (entry.preview) return <div className="genome-wheel-preview" ref={host} />
  return <div className={`genome-wheel-overview ${entry.active ? '' : 'inactive'}`}>
    {overview ? <>
      <div className="genome-wheel-locus">{overview.chrom}:{overview.start.toLocaleString()}–{overview.end.toLocaleString()} · Default locus</div>
      <svg viewBox="0 0 1000 160" role="img" aria-label={`Default-locus gene overview for ${entry.label}`}>
        {[35, 70, 105, 140].map(y => <line key={y} x1="15" x2="985" y1={y} y2={y} stroke="currentColor" opacity=".15" />)}
        {overview.genes.slice(0, 160).map((gene, index) => {
          const x = 15 + Math.max(0, (gene.start - overview.start) / (overview.end - overview.start)) * 970
          const end = 15 + Math.min(1, (gene.end - overview.start) / (overview.end - overview.start)) * 970
          const y = 30 + (index % 4) * 35
          return <g key={gene.gene_id || gene.id || index}><rect x={x} y={y} width={Math.max(2, end - x)} height="7" rx="2" fill="currentColor" /><title>{gene.name || gene.gene_id || gene.id}</title>{index < 18 && <text x={x} y={y - 5} fontSize="10" fill="currentColor">{gene.name || gene.gene_id}</text>}</g>
        })}
      </svg>
    </> : <div className="genome-wheel-preview-placeholder"><span>{failed ? 'Preview unavailable — select to open this genome' : 'Loading default-locus preview…'}</span></div>}
    {!entry.active && <small>Inactive · release to activate</small>}
  </div>
}

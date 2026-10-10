import { useEffect, useState } from 'react'

/**
 * Report toolbar edges with hidden controls for the fade and arrow indicators.
 * Observe the groups as well as the container because their widths can change
 * independently. ResizeObserver's initial report settles the first paint.
 */
export default function useScrollEdges(bar) {
  const [edges, setEdges] = useState('none')
  useEffect(() => {
    const el = bar.current
    if (!el) return
    const read = () => {
      const max = el.scrollWidth - el.clientWidth
      setEdges(max <= 1 ? 'none'
        : el.scrollLeft <= 1 ? 'right'
        : el.scrollLeft >= max - 1 ? 'left' : 'both')
    }
    el.addEventListener('scroll', read, { passive: true })
    const observer = new ResizeObserver(read)
    observer.observe(el)
    for (const group of el.children) observer.observe(group)
    return () => { el.removeEventListener('scroll', read); observer.disconnect() }
  }, [bar])
  return edges
}

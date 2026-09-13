import { useEffect, useState } from 'react'

/** Which edges of the control bar have controls hidden past them.
 *
 * A bar that silently hides its last control looks like a bar that has lost it,
 * and the platform's overlay scrollbar only appears once a scroll is already
 * under way - which is no use to someone who does not yet know there is one. So
 * the edge with more behind it is marked, and that mark is what the fade and
 * the arrow in `.al-toolbar-rail` are drawn from.
 *
 * The groups inside the bar are measured as well as the bar itself, because the
 * contents change width on their own - a grouped block overview names a range
 * of blocks where a single block names a number - and a group that can no
 * longer fit is the first thing to change size when they do. `ResizeObserver`
 * reports once when it starts observing, which is what settles the first paint.
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

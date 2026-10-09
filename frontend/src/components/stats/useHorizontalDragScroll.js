import { useCallback, useRef } from 'react'

export function useHorizontalDragScroll(ignoreSelector = '') {
  const scrollRef = useRef(null)
  const dragRef = useRef({ dragging: false, moved: false, startX: 0, scrollLeft: 0 })
  const suppressClickRef = useRef(false)

  const onMouseDown = useCallback((e) => {
    if (e.button !== 0) return
    if (ignoreSelector && e.target?.closest?.(ignoreSelector)) return
    const el = scrollRef.current
    if (!el) return
    dragRef.current = {
      dragging: true,
      moved: false,
      startX: e.pageX - el.offsetLeft,
      scrollLeft: el.scrollLeft,
    }
    suppressClickRef.current = false
    el.style.cursor = 'grabbing'
  }, [ignoreSelector])

  const onMouseMove = useCallback((e) => {
    const d = dragRef.current
    if (!d.dragging) return
    const el = scrollRef.current
    if (!el) return
    const x = e.pageX - el.offsetLeft
    const delta = x - d.startX
    if (Math.abs(delta) > 4) {
      d.moved = true
      suppressClickRef.current = true
    }
    if (!d.moved) return
    e.preventDefault()
    el.scrollLeft = d.scrollLeft - delta
  }, [])

  const onMouseUp = useCallback(() => {
    const wasMoved = dragRef.current.moved
    dragRef.current.dragging = false
    dragRef.current.moved = false
    const el = scrollRef.current
    if (el) el.style.cursor = 'grab'
    if (wasMoved) {
      window.setTimeout(() => {
        suppressClickRef.current = false
      }, 0)
    }
  }, [])

  const onClickCapture = useCallback((e) => {
    if (!suppressClickRef.current) return
    e.preventDefault()
    e.stopPropagation()
  }, [])

  return {
    scrollRef,
    onMouseDown,
    onMouseMove,
    onMouseUp,
    onMouseLeave: onMouseUp,
    onClickCapture,
  }
}

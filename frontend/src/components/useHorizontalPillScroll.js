import { useCallback, useEffect, useRef } from 'react'

export default function useHorizontalPillScroll(options = {}) {
  const scrollAmount = Number.isFinite(Number(options?.scrollAmount))
    ? Number(options.scrollAmount)
    : 200

  const scrollRef = useRef(null)
  const dragRef = useRef({ dragging: false, moved: false, startX: 0, scrollLeft: 0 })
  const suppressClickRef = useRef(false)

  const handleScroll = useCallback((direction) => {
    if (!scrollRef.current) return
    scrollRef.current.scrollBy({
      left: direction === 'left' ? -scrollAmount : scrollAmount,
      behavior: 'smooth',
    })
  }, [scrollAmount])

  const onMouseDown = useCallback((event) => {
    if (event.button !== 0) return
    const node = scrollRef.current
    if (!node) return
    dragRef.current = {
      dragging: true,
      moved: false,
      startX: event.pageX - node.offsetLeft,
      scrollLeft: node.scrollLeft,
    }
    suppressClickRef.current = false
    node.style.cursor = 'grabbing'
  }, [])

  const onMouseMove = useCallback((event) => {
    const drag = dragRef.current
    if (!drag.dragging) return
    const node = scrollRef.current
    if (!node) return
    const x = event.pageX - node.offsetLeft
    const delta = x - drag.startX
    if (Math.abs(delta) > 4) {
      drag.moved = true
      suppressClickRef.current = true
    }
    if (!drag.moved) return
    event.preventDefault()
    node.scrollLeft = drag.scrollLeft - delta
  }, [])

  const onMouseUp = useCallback(() => {
    const wasDragged = dragRef.current.moved
    dragRef.current.dragging = false
    dragRef.current.moved = false
    if (scrollRef.current) scrollRef.current.style.cursor = 'grab'
    if (wasDragged) {
      window.setTimeout(() => {
        suppressClickRef.current = false
      }, 0)
    }
  }, [])

  useEffect(() => {
    return () => {
      if (scrollRef.current) {
        scrollRef.current.style.cursor = 'grab'
      }
    }
  }, [])

  return {
    scrollRef,
    suppressClickRef,
    handleScroll,
    onMouseDown,
    onMouseMove,
    onMouseUp,
  }
}
